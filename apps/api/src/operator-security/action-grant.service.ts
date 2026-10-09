import { ActionGrantRequestSchema, type ActionGrantRequest, type ActionGrantView } from '@barter/contracts';
import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import argon2 from 'argon2';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { actionCapability, assertActionRole, canonicalHash, type ActionBinding, type OperatorActionContext, type OperatorSessionContext } from './operator-action.types.js';
import { OperatorSessionService } from './operator-session.service.js';

@Injectable()
export class ActionGrantService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(OperatorSessionService) private readonly sessions: OperatorSessionService, @Inject(CLOCK) private readonly clock: Clock, @Inject(AuditService) private readonly audit: AuditService) {}
  async issue(context: OperatorSessionContext, input: ActionGrantRequest): Promise<ActionGrantView> {
    const { password, ...binding } = ActionGrantRequestSchema.parse(input);
    return this.prisma.$transaction(async tx => {
      await this.sessions.assertCurrent(tx, context, actionCapability(input.action));
      assertActionRole(context.actor, input.action);
      const credential = await tx.adminCredential.findUnique({ where: { userId: context.actor.id } });
      if (!credential || !await argon2.verify(credential.passwordHash, password)) throw new UnauthorizedException('Password reauthentication failed');
      const createdAt = this.clock.now();
      const grant = await tx.actionGrant.create({ data: { actorId: context.actor.id, sessionId: context.sessionId, deviceId: context.deviceId, action: binding.action, resourceId: binding.resourceId, expectedVersion: 1, requestDigest: canonicalHash(binding), createdAt, expiresAt: new Date(createdAt.getTime() + 5 * 60_000) } });
      await this.audit.record(tx, { actorId: context.actor.id, action: 'OPERATOR_ACTION_REAUTHENTICATED', entityType: 'ActionGrant', entityId: grant.id, after: { action: binding.action, resourceId: binding.resourceId, expectedVersions: binding.expectedVersions, sessionId: context.sessionId, deviceId: context.deviceId } });
      return { id: grant.id, action: binding.action, resourceId: binding.resourceId, expectedVersions: binding.expectedVersions, expiresAt: grant.expiresAt.toISOString() };
    });
  }
  async consume(tx: Prisma.TransactionClient, context: OperatorActionContext, binding: ActionBinding): Promise<void> {
    await this.sessions.assertCurrent(tx, context, actionCapability(binding.action));
    assertActionRole(context.actor, binding.action);
    const updated = await tx.actionGrant.updateMany({ where: { id: context.grantId, actorId: context.actor.id, sessionId: context.sessionId, deviceId: context.deviceId, action: binding.action, resourceId: binding.resourceId, requestDigest: canonicalHash(binding), consumedAt: null, expiresAt: { gt: this.clock.now() } }, data: { consumedAt: this.clock.now() } });
    if (updated.count !== 1) throw new ForbiddenException({ code: 'GRANT_INVALID', message: 'Action grant is invalid or expired' });
    await this.audit.record(tx, { actorId: context.actor.id, action: 'OPERATOR_ACTION_GRANT_CONSUMED', entityType: 'ActionGrant', entityId: context.grantId, after: { action: binding.action, resourceId: binding.resourceId, sessionId: context.sessionId, deviceId: context.deviceId } });
  }
}
