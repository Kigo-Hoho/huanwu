import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import { INTEGRATION_CONFIG, type IntegrationConfiguration } from '../integrations/integration-config.js';
import type { IntegrationOperationHandler, ProviderOperation, ProviderResult } from '../integrations/integration.types.js';
import { OutboxHandlerRegistry } from '../integrations/outbox-handler.registry.js';
import { readOrder } from '../orders/order-reader.js';
import { mapOrder } from '../orders/order.mapper.js';
import { dueDeadline } from '../orders/order-policy.js';
import { LOGISTICS_PORT, type LogisticsPort } from './logistics.port.js';
import { LogisticsEventsService } from './logistics-events.service.js';
import { OrderExpiryService } from '../orders/order-expiry.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
@Injectable()
export class LogisticsOutboxHandler implements IntegrationOperationHandler, OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LOGISTICS_PORT) private readonly port: LogisticsPort,
    @Inject(LogisticsEventsService) private readonly events: LogisticsEventsService,
    @Inject(OutboxHandlerRegistry) private readonly registry: OutboxHandlerRegistry,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfiguration,
    @Inject(OrderExpiryService) private readonly expiry: OrderExpiryService,
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
  ) {}
  onModuleInit(): void { for (const kind of ['VERIFY_SHIPMENT', 'QUERY_SHIPMENT'] as const) this.registry.register(kind, this); }
  authorize(operation: ProviderOperation): Promise<boolean> {
    if (this.config.logistics === 'disabled' || !['VERIFY_SHIPMENT', 'QUERY_SHIPMENT'].includes(operation.kind) || typeof operation.payload.shipmentId !== 'string') return Promise.resolve(false);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${operation.orderId}::uuid FOR UPDATE`;
      const initial = await readOrder(tx, operation.orderId); if (!initial) return false;
      await this.reservations.lockItems(tx, initial.items.map(item => item.itemId));
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE "orderId" = ${initial.id}::uuid ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Shipment" WHERE id = ${operation.payload.shipmentId as string}::uuid FOR UPDATE`;
      const order = await readOrder(tx, operation.orderId); if (!order) return false;
      const shipment = await tx.shipment.findUnique({ where: { id: operation.payload.shipmentId as string } });
      if (!shipment || shipment.orderId !== order.id || shipment.businessNo !== operation.businessNo || shipment.carrier !== operation.payload.carrier || shipment.trackingNumber !== operation.payload.trackingNumber || order.deliveryMode !== 'COURIER') return false;
      if (await this.expiry.reconcileLocked(tx, order.id)) {
        await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
        return false;
      }
      if (!['AWAITING_FULFILLMENT', 'IN_TRANSIT', 'AWAITING_ACCEPTANCE'].includes(order.status) || !order.parties.every(p => p.fundsReady) || order.cancellations.some(c => c.status === 'REQUESTED') || dueDeadline(mapOrder(order), this.clock.now())) return false;
      if (!await tx.auditLog.count({ where: { action: 'ORDER_LOGISTICS_OPERATION_ADMITTED', entityId: shipment.id } })) {
        await this.audit.record(tx, { actorId: null, action: 'ORDER_LOGISTICS_OPERATION_ADMITTED', entityType: 'Shipment', entityId: shipment.id, after: { businessNo: operation.businessNo, kind: operation.kind } });
        await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
      }
      return true;
    });
  }
  query(operation: ProviderOperation): Promise<ProviderResult> { return this.port.queryShipment(operation.businessNo); }
  execute(operation: ProviderOperation): Promise<ProviderResult> { return operation.kind === 'VERIFY_SHIPMENT' ? this.port.verifyShipment(operation) : this.port.queryShipment(operation.businessNo); }
  async apply(operation: ProviderOperation, result: ProviderResult): Promise<void> {
    if (result.status !== 'SUCCESS') return;
    if (result.event.kind !== 'SHIPMENT_PROGRESS' || result.event.businessNo !== operation.businessNo || result.event.shipmentId !== operation.payload.shipmentId || result.externalTransactionId !== result.event.shipmentId) throw new Error('Provider result does not match the shipment operation');
    await this.events.applyVerified(result.event);
  }
}
