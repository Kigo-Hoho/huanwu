import { createHmac, randomUUID } from 'node:crypto';
import { OrderCommandResultSchema, OrderShipmentSchema, type OrderCommandInput, type OrderCommandResult, type OrderShipmentInput } from '@barter/contracts';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { assertPureCustomer } from '../auth/customer-only.guard.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma, ShipmentStatus } from '../generated/prisma/client.js';
import { INTEGRATION_CONFIG, integrationUnavailable, type IntegrationConfiguration } from '../integrations/integration-config.js';
import { OutboxService } from '../integrations/outbox.service.js';
import { SimulatedLogisticsAdapter } from '../integrations/simulated-logistics.adapter.js';
import { SimulatedProviderStore } from '../integrations/simulated-provider.store.js';
import { OrderCommandsService, assertOrderParticipant, orderRequestHash, replayOrderCommand, uniqueConflict } from '../orders/order-commands.service.js';
import { mapOrder } from '../orders/order.mapper.js';
import { dueDeadline } from '../orders/order-policy.js';
import { OrderExpiryService } from '../orders/order-expiry.service.js';
import { readOrder } from '../orders/order-reader.js';
import { LogisticsEventsService } from './logistics-events.service.js';
export type ShipmentProgressInput = OrderCommandInput & { progress: Exclude<ShipmentStatus, 'REGISTERED'> };

@Injectable()
export class ShipmentsService {
  constructor(
    @Inject(OrderCommandsService) private readonly commands: OrderCommandsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfiguration,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LogisticsEventsService) private readonly events: LogisticsEventsService,
    @Inject(SimulatedProviderStore) private readonly store: SimulatedProviderStore,
    @Inject(SimulatedLogisticsAdapter) private readonly adapter: SimulatedLogisticsAdapter,
    @Inject(OrderExpiryService) private readonly expiry: OrderExpiryService,
  ) {}
  async submit(actor: AuthenticatedUser, id: string, raw: OrderShipmentInput, key: string, requestId?: string): Promise<OrderCommandResult> {
    const input = OrderShipmentSchema.parse(raw);
    try {
      return await this.commands.execute({ actor, id, input, key, requestId, commandName: 'SUBMIT_ORDER_SHIPMENT' }, async (tx, order, now) => {
        if (this.config.logistics === 'disabled') throw integrationUnavailable();
        if (order.deliveryMode !== 'COURIER' || order.status !== 'AWAITING_FULFILLMENT' || !order.parties.every(p => p.fundsReady)) throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Order is not ready for shipping' });
        if (order.cancellations.some(c => c.status === 'REQUESTED')) throw new ConflictException({ code: 'ORDER_CANCELLATION_PENDING', message: 'Cancellation is pending' });
        const side = order.initiatorId === actor.id ? 'INITIATOR' : 'RECIPIENT';
        if (order.shipments.some(s => s.side === side)) throw new ConflictException({ code: 'ORDER_FULFILLMENT_STARTED', message: 'Own shipment is already registered' });
        const address = await tx.orderAddress.findUnique({ where: { orderId_side: { orderId: id, side: side === 'INITIATOR' ? 'RECIPIENT' : 'INITIATOR' } } });
        if (!address?.frozenAt) throw new ConflictException({ code: 'ORDER_DETAILS_REQUIRED', message: 'Frozen destination address is required' });
        const snapshotIds = order.items.filter(item => item.side === side).map(item => item.id).sort();
        if (!snapshotIds.length || (side === 'INITIATOR' ? snapshotIds.length > 5 : snapshotIds.length !== 1)) throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Shipment must bind the full own side' });
        const shipmentId = randomUUID();
        await tx.shipment.create({ data: { id: shipmentId, orderId: id, side, carrier: input.carrier, trackingNumber: input.trackingNumber, businessNo: `shipment:${shipmentId}`, registeredAt: now } });
        await this.outbox.enqueue(tx, { orderId: id, businessNo: `shipment:${shipmentId}`, kind: 'VERIFY_SHIPMENT', payload: { shipmentId, carrier: input.carrier, trackingNumber: input.trackingNumber } });
        return { auditAction: 'ORDER_SHIPMENT_SUBMITTED', auditMetadata: { shipmentId, side, snapshotIds, addressId: address.id, addressVersion: address.version } };
      });
    } catch (error) { if (uniqueConflict(error)) throw new ConflictException({ code: 'TRACKING_NUMBER_IN_USE', message: 'Tracking number is already registered' }); throw error; }
  }
  async progressSimulated(actor: AuthenticatedUser, shipmentId: string, input: ShipmentProgressInput, key: string, requestId?: string): Promise<OrderCommandResult> {
    assertPureCustomer(actor); this.store.assertEnabled('logistics');
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Shipment was not found' });
    const order = await readOrder(this.prisma, shipment.orderId); assertOrderParticipant(order, actor.id);
    if ((shipment.side === 'INITIATOR' ? order.initiatorId : order.recipientId) !== actor.id) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Only the sender can progress own shipment' });
    const commandName = 'PROGRESS_SIMULATED_SHIPMENT'; const normalized = { ...input, shipmentId }; const hash = orderRequestHash(order.id, normalized);
    const where = { actorId_commandName_key: { actorId: actor.id, commandName, key } };
    await this.commands.execute({ actor, id: order.id, input: normalized, key, commandName, requestId, admissionShipmentId: shipmentId }, async (tx, current) => {
      const own = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      if (own.orderId !== current.id || (own.side === 'INITIATOR' ? current.initiatorId : current.recipientId) !== actor.id) throw new ForbiddenException();
      this.assertProgress(current, own.status, input.progress);
      return { auditAction: 'SIMULATED_SHIPMENT_PROGRESS_ADMITTED' };
    });
    const admission = await this.prisma.idempotencyRecord.findUniqueOrThrow({ where });
    if ((admission.response as Prisma.JsonObject).status !== 'IN_PROGRESS') return replayOrderCommand(admission, hash);
    let external = await this.adapter.queryShipment(shipment.businessNo);
    const matches = () => external.status === 'SUCCESS' && external.event.kind === 'SHIPMENT_PROGRESS' && external.event.businessNo === shipment.businessNo && external.event.shipmentId === shipmentId &&
      (external.event.progress === input.progress || (input.progress === 'COLLECTED' && external.event.progress === 'DELIVERED'));
    if (!matches()) {
      const denied = await this.authorizeFreshProgress(actor, order.id, shipmentId, input.progress);
      if (denied) {
        if ((denied.getResponse() as { code?: string }).code === 'ORDER_EXPIRED') await this.expiry.reconcile(order.id);
        external = await this.adapter.queryShipment(shipment.businessNo); if (!matches()) throw denied;
      }
      else {
        if (external.status !== 'PENDING' && external.status !== 'SUCCESS') throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'External shipment registration is not ready' });
        if (input.progress === 'DELIVERED' && (external.status !== 'SUCCESS' || external.event.kind !== 'SHIPMENT_PROGRESS' || external.event.progress !== 'COLLECTED')) throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Collection is required before delivery' });
        const candidate = { provider: 'simulated', eventId: `progress:${shipmentId}:${input.progress}`, kind: 'SHIPMENT_PROGRESS', businessNo: shipment.businessNo, occurredAt: admission.createdAt.toISOString(), shipmentId, progress: input.progress };
        const raw = JSON.stringify(candidate); const event = this.adapter.verifySignedEvent(raw, createHmac('sha256', this.config.signingKey!).update(raw).digest('hex'));
        await this.store.recordEvent(event); external = await this.adapter.queryShipment(shipment.businessNo);
      }
    }
    if (external.status !== 'SUCCESS' || external.event.kind !== 'SHIPMENT_PROGRESS' || external.event.shipmentId !== shipmentId || external.event.businessNo !== shipment.businessNo) throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'External shipment progress is not confirmed' });
    await this.events.applyVerified(external.event);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id}::uuid FOR UPDATE`;
      const current = await readOrder(tx, order.id); assertOrderParticipant(current, actor.id);
      const saved = await tx.idempotencyRecord.findUniqueOrThrow({ where });
      if ((saved.response as Prisma.JsonObject).status !== 'IN_PROGRESS') return replayOrderCommand(saved, hash);
      const result = OrderCommandResultSchema.parse({ order: mapOrder(current) }); await tx.idempotencyRecord.update({ where, data: { response: result as unknown as Prisma.InputJsonObject } }); return result;
    });
  }
  private assertProgress(order: NonNullable<Awaited<ReturnType<typeof readOrder>>>, status: ShipmentStatus, progress: ShipmentProgressInput['progress']): void {
    if (order.deliveryMode !== 'COURIER' || !['AWAITING_FULFILLMENT', 'IN_TRANSIT', 'AWAITING_ACCEPTANCE'].includes(order.status) || !order.parties.every(p => p.fundsReady) || status === 'EXCEPTION' || status === 'DELIVERED') throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Order does not allow fresh shipment progress' });
    if (order.cancellations.some(c => c.status === 'REQUESTED')) throw new ConflictException({ code: 'ORDER_CANCELLATION_PENDING', message: 'Cancellation is pending' });
    if (progress === 'DELIVERED' && status !== 'COLLECTED') throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Collection is required before delivery' });
  }
  private authorizeFreshProgress(actor: AuthenticatedUser, orderId: string, shipmentId: string, progress: ShipmentProgressInput['progress']): Promise<ConflictException | null> {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Shipment" WHERE id = ${shipmentId}::uuid FOR UPDATE`;
      const order = await readOrder(tx, orderId); assertOrderParticipant(order, actor.id);
      const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      const user = await tx.user.findUnique({ where: { id: actor.id }, select: { id: true, disabledAt: true, wechatOpenid: true, roles: { select: { role: true } }, adminCredential: { select: { userId: true } } } });
      if (!user || user.disabledAt || user.wechatOpenid === null || user.adminCredential !== null) throw new UnauthorizedException('Customer identity is unavailable');
      assertPureCustomer({ id: user.id, roles: user.roles.map(r => r.role) });
      if (shipment.orderId !== order.id || (shipment.side === 'INITIATOR' ? order.initiatorId : order.recipientId) !== actor.id) throw new ForbiddenException();
      try { this.assertProgress(order, shipment.status, progress); } catch (error) { if (error instanceof ConflictException) return error; throw error; }
      if (dueDeadline(mapOrder(order), this.clock.now())) return new ConflictException({ code: 'ORDER_EXPIRED', message: 'Fulfillment deadline has passed' });
      return null;
    });
  }
}
