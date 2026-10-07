import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { VerifiedIntegrationEvent } from '../integrations/integration.types.js';
import { INTEGRATION_CONFIG, type IntegrationConfiguration } from '../integrations/integration-config.js';
import { OrderHoldService } from '../orders/order-hold.service.js';
import { OrderExpiryService } from '../orders/order-expiry.service.js';
import { readOrder } from '../orders/order-reader.js';
import { ReservationsService } from '../reservations/reservations.service.js';

@Injectable()
export class LogisticsEventsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfiguration,
    @Inject(OrderHoldService) private readonly hold: OrderHoldService,
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
    @Inject(OrderExpiryService) private readonly expiry: OrderExpiryService,
  ) {}
  async applyVerified(event: VerifiedIntegrationEvent): Promise<void> {
    if (event.kind !== 'SHIPMENT_PROGRESS') throw new BadRequestException({ code: 'INTEGRATION_EVENT_INVALID', message: 'Expected a logistics event' });
    const association = await this.prisma.shipment.findUnique({ where: { businessNo: event.businessNo } });
    await this.prisma.$transaction(async tx => {
      if (association) {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${association.orderId}::uuid FOR UPDATE`;
        const order = await readOrder(tx, association.orderId); if (!order) throw new Error('Shipment order is missing');
        await this.reservations.lockItems(tx, order.items.map(item => item.itemId));
        await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE "orderId" = ${order.id}::uuid ORDER BY id FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Shipment" WHERE "orderId" = ${order.id}::uuid ORDER BY id FOR UPDATE`;
      }
      const inserted = await tx.integrationEvent.createMany({ data: [{ ...event, occurredAt: new Date(event.occurredAt), payload: event as unknown as Prisma.InputJsonObject }], skipDuplicates: true });
      const recorded = await tx.integrationEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: event.provider, eventId: event.eventId } } });
      if (!inserted.count) {
        if (!isDeepStrictEqual(recorded.payload, event)) throw new BadRequestException({ code: 'INTEGRATION_EVENT_INVALID', message: 'Event identity has conflicting content' });
        return;
      }
      const now = this.clock.now();
      const receipt = (status: 'PROCESSED' | 'REJECTED', reason: string | null = null) => tx.integrationEventReceipt.create({ data: { eventId: recorded.id, status, reason, processedAt: now } });
      if (!association || event.shipmentId !== association.id || event.provider !== this.config.logistics || event.businessNo !== `shipment:${association.id}`) {
        const reason = association ? 'SHIPMENT_MISMATCH' : 'UNKNOWN_BUSINESS_NUMBER'; await receipt('REJECTED', reason);
        await this.audit.record(tx, { actorId: null, action: 'LOGISTICS_EVENT_QUARANTINED', entityType: 'IntegrationEvent', entityId: recorded.id, after: { reason } }); return;
      }
      const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: association.id } });
      const order = (await readOrder(tx, shipment.orderId))!;
      if (order.deliveryMode !== 'COURIER') {
        await receipt('REJECTED', 'WRONG_DELIVERY_MODE'); await this.audit.record(tx, { actorId: null, action: 'LOGISTICS_EVENT_QUARANTINED', entityType: 'IntegrationEvent', entityId: recorded.id, after: { reason: 'WRONG_DELIVERY_MODE' } }); return;
      }
      await tx.shipmentEvent.create({ data: { shipmentId: shipment.id, integrationEventId: recorded.id, progress: event.progress, occurredAt: new Date(event.occurredAt), createdAt: now } });
      // Decide expiry from the current accepted facts before adding this late fact.
      let held = await this.expiry.reconcileLocked(tx, order.id);
      if (!held && event.progress === 'EXCEPTION' && !['ON_HOLD', 'COMPLETED', 'CANCELLED'].includes(order.status)) { await this.hold.enter(tx, order, 'LOGISTICS_EXCEPTION', now); held = true; }
      const rank = { REGISTERED: 0, COLLECTED: 1, DELIVERED: 2, EXCEPTION: 3 };
      const advanced = rank[event.progress] > rank[shipment.status];
      if (advanced) {
        await tx.shipment.update({ where: { id: shipment.id }, data: { status: event.progress, ...(event.progress === 'COLLECTED' && !shipment.collectedAt ? { collectedAt: new Date(event.occurredAt) } : {}), ...(event.progress === 'DELIVERED' && !shipment.deliveredAt ? { deliveredAt: new Date(event.occurredAt) } : {}) } });
      }
      const deliveryEvidence = event.progress === 'DELIVERED' && !shipment.deliveredAt && shipment.status === 'EXCEPTION';
      if (deliveryEvidence) await tx.shipment.update({ where: { id: shipment.id }, data: { deliveredAt: new Date(event.occurredAt) } });
      // Facts remain visible after a hold/terminal decision, but cannot reopen fulfillment.
      if (advanced && event.progress === 'DELIVERED') {
        const incomingSide = shipment.side === 'INITIATOR' ? 'RECIPIENT' : 'INITIATOR';
        const receiver = order.parties.find(p => p.side === incomingSide)!;
        if (!receiver.incomingDeliveredAt) await tx.orderPartyProgress.update({ where: { orderId_side: { orderId: order.id, side: incomingSide } }, data: { incomingDeliveredAt: now, acceptanceDeadline: new Date(now.getTime() + order.inspectionHours * 3600000) } });
      }
      if (!held && ['AWAITING_FULFILLMENT', 'IN_TRANSIT', 'AWAITING_ACCEPTANCE'].includes(order.status)) {
        const current = (await readOrder(tx, order.id))!;
        if (current.shipments.length === 2 && current.shipments.every(s => s.status === 'DELIVERED')) await tx.order.update({ where: { id: order.id }, data: { status: 'AWAITING_ACCEPTANCE', fulfillmentDeadline: null } });
        else if (current.shipments.length === 2 && current.shipments.every(s => ['COLLECTED', 'DELIVERED'].includes(s.status))) await tx.order.update({ where: { id: order.id }, data: { status: 'IN_TRANSIT', fulfillmentDeadline: null } });
      }
      await receipt('PROCESSED', held || order.status === 'ON_HOLD' ? 'ORDER_ON_HOLD' : null);
      if (advanced || held || deliveryEvidence) {
        await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
        await this.audit.record(tx, { actorId: null, action: deliveryEvidence ? 'LOGISTICS_DELIVERY_EVIDENCE_RECORDED' : 'ORDER_SHIPMENT_PROGRESS_CONFIRMED', entityType: 'Order', entityId: order.id, after: { shipmentId: shipment.id, eventId: recorded.id, progress: event.progress } });
      } else await this.audit.record(tx, { actorId: null, action: 'LOGISTICS_EVENT_RECORDED', entityType: 'IntegrationEvent', entityId: recorded.id, after: { shipmentId: shipment.id, progress: event.progress } });
    });
  }
}
