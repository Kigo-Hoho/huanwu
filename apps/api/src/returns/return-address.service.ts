import { ReturnAddressSchema, ReturnAddressViewSchema, type ReturnAddressInput } from '@barter/contracts';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CaseCommandsService } from '../after-sales/case-commands.service.js';
import { assertCaseParticipant, assertCurrentCustomer } from '../after-sales/case-policy.js';
import { currentResolution } from '../after-sales/resolution-policy.js';
import { readCase } from '../after-sales/case-reader.js';
import { PrismaService } from '../database/prisma.service.js';
import { AddressCipher } from '../orders/address-cipher.js';
import { readOrder } from '../orders/order-reader.js';
import { returnNotReady } from './return-plan.service.js';

@Injectable()
export class ReturnAddressService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(CaseCommandsService) private readonly commands: CaseCommandsService, @Inject(AddressCipher) private readonly cipher: AddressCipher, @Inject(AuditService) private readonly audit: AuditService) {}
  save(actor: AuthenticatedUser, caseId: string, raw: ReturnAddressInput, key: string, requestId?: string) {
    const parsed = ReturnAddressSchema.safeParse(raw); if (!parsed.success) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Invalid private return address' });
    const input = parsed.data;
    return this.commands.run({ actor, caseId, input, key, requestId, commandName: 'RETURN_ADDRESS_SAVED' }, async ctx => {
      const resolution = currentResolution(ctx.case, input.resolutionVersion);
      if (resolution.type !== 'RETURN_ORIGINALS' || ctx.order.deliveryMode !== 'COURIER' || ctx.case.status === 'EXECUTING') returnNotReady('Address cannot be changed');
      const side = ctx.order.initiatorId === actor.id ? 'INITIATOR' : 'RECIPIENT';
      const where = { caseId_side: { caseId, side } } as const;
      const previous = await ctx.tx.returnAddress.findUnique({ where });
      if (previous?.frozenAt) returnNotReady('Return address is frozen');
      const version = (previous?.version ?? 0) + 1;
      const { recipientName, phone, region, detail } = input;
      const encrypted = this.cipher.encrypt({ recipientName, phone, region, detail, orderId: caseId, side, version }, { orderId: caseId, side, version, namespace: 'return-address-v1' });
      await ctx.tx.returnAddress.upsert({ where, create: { caseId, side, version, ...encrypted }, update: { version, ...encrypted } });
    });
  }
  async get(actor: AuthenticatedUser, caseId: string, side: 'self'|'outgoing', requestId?: string) {
    if (!['self', 'outgoing'].includes(side)) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Invalid address side' });
    const located = await readCase(this.prisma, caseId);
    const order = located ? await readOrder(this.prisma, located.orderId) : null;
    assertCaseParticipant(order, located, actor.id);
    return this.prisma.$transaction(async tx => {
      await assertCurrentCustomer(tx, actor);
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${located!.orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "AfterSalesCase" WHERE id = ${caseId}::uuid FOR UPDATE`;
      const value = await readCase(tx, caseId); const current = await readOrder(tx, located!.orderId);
      assertCaseParticipant(current, value, actor.id);
      const own = current!.initiatorId === actor.id ? 'INITIATOR' : 'RECIPIENT';
      const target = side === 'self' ? own : own === 'INITIATOR' ? 'RECIPIENT' : 'INITIATOR';
      if (side === 'outgoing') {
        const resolution = value!.resolutions.find(r => r.number === value!.currentResolutionVersion);
        if (value!.status !== 'EXECUTING' || resolution?.type !== 'RETURN_ORIGINALS' || !resolution.returnObligations.some(o => o.holderSide === own && o.ownerSide === target && o.deliveryMode === 'COURIER' && o.progress && ['PENDING', 'REGISTERED', 'COLLECTED', 'DELIVERED'].includes(o.progress.status))) returnNotReady('No active outgoing return obligation');
      }
      const address = await tx.returnAddress.findUnique({ where: { caseId_side: { caseId, side: target } } });
      if (!address || (side === 'outgoing' && !address.frozenAt)) returnNotReady('Return address is unavailable');
      const plain = this.cipher.decrypt(address, { orderId: caseId, side: target, version: address.version, namespace: 'return-address-v1' });
      if (side === 'outgoing') await this.audit.record(tx, { actorId: actor.id, action: 'RETURN_OUTGOING_ADDRESS_READ', entityType: 'AfterSalesCase', entityId: caseId, requestId, after: { side: target, version: address.version } });
      return ReturnAddressViewSchema.parse({ recipientName: plain.recipientName, phone: plain.phone, region: plain.region, detail: plain.detail, side: plain.side, version: plain.version, caseId });
    });
  }
}
