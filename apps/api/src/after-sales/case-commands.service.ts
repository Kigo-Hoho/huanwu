import { AdminCaseCommandResultSchema, CaseCommandResultSchema, ProposalIdempotencyKeySchema, type CaseCommandResult, type OperatorAction } from '@barter/contracts';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { actionCapability, assertActionRole, canonicalHash, type OperatorSessionContext } from '../operator-security/operator-action.types.js';
import { OperatorSessionService } from '../operator-security/operator-session.service.js';
import { readOrder } from '../orders/order-reader.js';
import { mapAdminCase, mapCase } from './case.mapper.js';
import { assertCaseOperator, assertCaseParticipant, assertCurrentCustomer, assertOpenCase } from './case-policy.js';
import { readCase } from './case-reader.js';
import type { CaseCommandContext, CaseMutationContext, CaseTx } from './case.types.js';

export interface OperatorCaseCommandContext extends CaseCommandContext { operatorSession: OperatorSessionContext; requiredAction?: OperatorAction }
export function assertCaseKey(key: string): void {
  if (!ProposalIdempotencyKeySchema.safeParse(key).success) throw new BadRequestException('A valid Idempotency-Key is required');
}
export async function replayCaseCommand(tx: CaseTx, identity: { actorId: string; commandName: string; key: string }, requestHash: string, operator = false): Promise<CaseCommandResult | null> {
  const previous = await tx.idempotencyRecord.findUnique({ where: { actorId_commandName_key: identity } });
  if (!previous) return null;
  if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'Idempotency key was used with different content' });
  return (operator ? AdminCaseCommandResultSchema : CaseCommandResultSchema).parse(previous.response);
}
export async function caseTransaction<T>(prisma: PrismaService, run: (tx: CaseTx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(run);
  }
  catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2002') throw error;
    // Another order can race on the actor/command/key unique constraint.
    // Re-enter the complete transaction so authorization still precedes replay.
    return prisma.$transaction(run);
  }
}
@Injectable()
export class CaseCommandsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OperatorSessionService) private readonly sessions: OperatorSessionService,
  ) {}
  async run(context: CaseCommandContext | OperatorCaseCommandContext, mutate: (ctx: CaseMutationContext) => Promise<void>): Promise<CaseCommandResult> {
    assertCaseKey(context.key);
    const identity = { actorId: context.actor.id, commandName: context.commandName, key: context.key };
    const requestHash = canonicalHash({ id: context.caseId, input: context.input });
    // Immutable association locates the order before acquiring any business lock.
    const located = await this.prisma.afterSalesCase.findUnique({ where: { id: context.caseId }, select: { orderId: true } });
    if (!located) throw new NotFoundException({ code: 'AFTER_SALES_NOT_FOUND', message: 'After-sales case was not found' });
    return caseTransaction(this.prisma, async tx => {
      if ('operatorSession' in context) {
        await this.sessions.assertCurrent(tx, context.operatorSession, context.requiredAction ? actionCapability(context.requiredAction) : 'MOBILE_LIMITED');
        assertCaseOperator(context.operatorSession.actor);
        if (context.requiredAction) assertActionRole(context.operatorSession.actor, context.requiredAction);
        if (context.actor.id !== context.operatorSession.actor.id) throw new ForbiddenException('Command actor differs from its operator session');
      } else await assertCurrentCustomer(tx, context.actor);
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${located.orderId}::uuid FOR UPDATE`;
      const order = await readOrder(tx, located.orderId);
      await tx.$queryRaw`SELECT id FROM "AfterSalesCase" WHERE id = ${context.caseId}::uuid FOR UPDATE`;
      const value = await readCase(tx, context.caseId);
      if (!('operatorSession' in context)) assertCaseParticipant(order, value, context.actor.id);
      if (!order || !value) throw new NotFoundException({ code: 'AFTER_SALES_NOT_FOUND', message: 'After-sales case was not found' });
      const replay = await replayCaseCommand(tx, identity, requestHash, 'operatorSession' in context);
      if (replay) return replay;
      if (value.version !== context.input.expectedCaseVersion) throw new ConflictException({ code: 'CASE_VERSION_CONFLICT', message: 'Case has changed' });
      if (order.version !== context.input.expectedOrderVersion) throw new ConflictException({ code: 'ORDER_VERSION_CONFLICT', message: 'Order has changed' });
      assertOpenCase(value);
      const operator = 'operatorSession' in context;
      const before = operator ? mapAdminCase(value) : mapCase(value);
      await mutate({ tx, order, case: value, now: this.clock.now(), actor: context.actor });
      await tx.afterSalesCase.update({ where: { id: value.id }, data: { version: { increment: 1 } } });
      await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
      const updated = await tx.afterSalesCase.findUniqueOrThrow({ where: { id: value.id } });
      const result = (operator ? AdminCaseCommandResultSchema : CaseCommandResultSchema).parse({ case: operator ? mapAdminCase(updated) : mapCase(updated), orderVersion: order.version + 1 });
      await this.audit.record(tx, {
        actorId: context.actor.id, action: context.commandName,
        entityType: 'AfterSalesCase', entityId: value.id, requestId: context.requestId,
        before: before as unknown as Prisma.InputJsonValue,
        after: result as unknown as Prisma.InputJsonValue,
      });
      await tx.idempotencyRecord.create({ data: { ...identity, requestHash, response: result as unknown as Prisma.InputJsonValue } });
      return result;
    });
  }
}
