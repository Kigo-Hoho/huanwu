import { OrderAddressSchema, type OrderAddressInput, type OrderAddressView, type OrderCommandResult } from '@barter/contracts';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { assertPureCustomer } from '../auth/customer-only.guard.js';
import { PrismaService } from '../database/prisma.service.js';
import { AddressCipher } from './address-cipher.js';
import { assertOrderParticipant, OrderCommandsService } from './order-commands.service.js';
import { readOrder } from './order-reader.js';
import { OrderExpiryService } from './order-expiry.service.js';

@Injectable()
export class OrderAddressService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrderCommandsService) private readonly commands: OrderCommandsService,
    @Inject(AddressCipher) private readonly cipher: AddressCipher,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrderExpiryService) private readonly expiry: OrderExpiryService,
  ) {}
  async save(actor: AuthenticatedUser, id: string, input: OrderAddressInput, key: string, requestId?: string): Promise<OrderCommandResult> {
    assertPureCustomer(actor);
    const parsed = OrderAddressSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Invalid shipping details' });
    return this.commands.execute({ actor, id, input: parsed.data, key, commandName: 'SAVE_ORDER_ADDRESS', requestId }, async (tx, order, now) => {
      if (order.deliveryMode !== 'COURIER' || order.status !== 'AWAITING_DETAILS') throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Shipping details cannot be changed' });
      const side = order.initiatorId === actor.id ? 'INITIATOR' : 'RECIPIENT';
      const where = { orderId_side: { orderId: id, side } } as const;
      const previous = await tx.orderAddress.findUnique({ where });
      if (previous?.frozenAt) throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Shipping details are frozen' });
      const version = (previous?.version ?? 0) + 1;
      const { recipientName, phone, region, detail } = parsed.data;
      const details = { recipientName, phone, region, detail };
      const encrypted = this.cipher.encrypt({ ...details, orderId: id, side, version }, { orderId: id, side, version });
      const saved = await tx.orderAddress.upsert({ where, create: { orderId: id, side, version, ...encrypted }, update: { version, ...encrypted } });
      await tx.orderPartyProgress.update({ where, data: { addressReady: true } });
      const addresses = await tx.orderAddress.findMany({ where: { orderId: id }, orderBy: { side: 'asc' } });
      if (addresses.length === 2) {
        await tx.orderAddress.updateMany({ where: { orderId: id }, data: { frozenAt: now } });
        await tx.order.update({ where: { id }, data: { status: 'AWAITING_PAYMENT', detailsDeadline: null, paymentDeadline: new Date(now.getTime() + order.paymentHours * 3600000) } });
        await this.audit.record(tx, { actorId: actor.id, action: 'ORDER_ADDRESSES_FROZEN', entityType: 'Order', entityId: id, requestId, after: { addresses: addresses.map(address => ({ side: address.side, version: address.version })) } });
      }
      await this.audit.record(tx, { actorId: actor.id, action: 'ORDER_ADDRESS_CHANGED', entityType: 'OrderAddress', entityId: saved.id, requestId, before: { side, version: previous?.version ?? 0 }, after: { side, version } });
      return { auditAction: 'ORDER_ADDRESS_SAVED' };
    });
  }
  async get(actor: AuthenticatedUser, id: string, options: { side: 'self' | 'outgoing' }, requestId?: string): Promise<OrderAddressView> {
    assertPureCustomer(actor);
    if (options.side !== 'self' && options.side !== 'outgoing') throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Invalid shipping address side' });
    assertOrderParticipant(await readOrder(this.prisma, id), actor.id);
    await this.expiry.reconcile(id);
    return this.prisma.$transaction(async tx => {
      const order = await readOrder(tx, id);
      assertOrderParticipant(order, actor.id);
      if (order.deliveryMode !== 'COURIER') throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Order does not use shipping details' });
      const self = order.initiatorId === actor.id ? 'INITIATOR' : 'RECIPIENT';
      const outgoing = options.side === 'outgoing';
      if (outgoing && (!['AWAITING_FULFILLMENT', 'IN_TRANSIT', 'AWAITING_ACCEPTANCE'].includes(order.status) || order.parties.length !== 2 || !order.parties.every(party => party.fundsReady))) throw new ConflictException({ code: 'ORDER_PAYMENT_NOT_READY', message: 'Outgoing shipping details are unavailable' });
      if (outgoing && await tx.orderCancellation.findFirst({ where: { orderId: id, status: 'REQUESTED' }, select: { id: true } })) throw new ConflictException({ code: 'ORDER_CANCELLATION_PENDING', message: 'Cancellation response is pending' });
      const side = outgoing ? (self === 'INITIATOR' ? 'RECIPIENT' : 'INITIATOR') : self;
      const address = await tx.orderAddress.findUnique({ where: { orderId_side: { orderId: id, side } } });
      if (!address || (outgoing && !address.frozenAt)) throw new ConflictException({ code: 'ORDER_DETAILS_REQUIRED', message: 'Shipping details are not ready' });
      const view = this.cipher.decrypt(address, { orderId: id, side, version: address.version });
      if (outgoing) await this.audit.record(tx, { actorId: actor.id, action: 'ORDER_OUTGOING_ADDRESS_READ', entityType: 'Order', entityId: id, requestId, after: { side, version: address.version } });
      return view;
    }, { isolationLevel: 'RepeatableRead' });
  }
}
