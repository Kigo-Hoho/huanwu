import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { LOGISTICS_PORT, type LogisticsPort } from '../logistics/logistics.port.js';
import { OutboxHandlerRegistry } from '../integrations/outbox-handler.registry.js';
import type { IntegrationOperationHandler, ProviderOperation, ProviderResult } from '../integrations/integration.types.js';
import { INTEGRATION_CONFIG, type IntegrationConfiguration } from '../integrations/integration-config.js';
import { ReturnEventsService } from './return-events.service.js';

@Injectable()
export class ReturnLogisticsHandler implements IntegrationOperationHandler, OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(LOGISTICS_PORT) private readonly port: LogisticsPort, @Inject(OutboxHandlerRegistry) private readonly registry: OutboxHandlerRegistry, @Inject(ReturnEventsService) private readonly events: ReturnEventsService, @Inject(AuditService) private readonly audit: AuditService, @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfiguration) {}
  onModuleInit(): void { this.registry.register('VERIFY_RETURN', this); this.registry.register('CLOSE_OR_INTERCEPT', this); }
  async authorize(operation: ProviderOperation): Promise<boolean> {
    if (this.config.logistics === 'disabled' || typeof operation.payload.caseId !== 'string' || typeof operation.payload.resolutionId !== 'string' || typeof operation.payload.shipmentId !== 'string') return false;
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${operation.orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "AfterSalesCase" WHERE id = ${operation.payload.caseId as string}::uuid FOR UPDATE`;
      const value = await tx.afterSalesCase.findUnique({ where: { id: operation.payload.caseId as string } });
      const resolution = await tx.resolutionVersion.findUnique({ where: { id: operation.payload.resolutionId as string } });
      if (!value || value.orderId !== operation.orderId || value.status !== 'EXECUTING' || resolution?.caseId !== value.id || resolution.type !== 'RETURN_ORIGINALS' || resolution.number !== value.currentResolutionVersion) return false;
      const durable = await tx.outboxCommand.findUnique({ where: { businessNo: operation.businessNo } });
      if (!durable || durable.orderId !== operation.orderId || durable.kind !== operation.kind || JSON.stringify(durable.payload) !== JSON.stringify(operation.payload)) return false;
      if (operation.kind === 'VERIFY_RETURN') {
        const shipment = await tx.returnShipment.findUnique({ where: { id: operation.payload.shipmentId as string }, include: { items: { include: { obligation: { include: { progress: true } } } } } });
        if (!shipment || shipment.resolutionId !== resolution.id || shipment.businessNo !== operation.businessNo || !shipment.items.length || shipment.items.some(i => !i.obligation.progress || !['REGISTERED', 'COLLECTED'].includes(i.obligation.progress.status))) return false;
        const original = await tx.shipment.findUnique({ where: { orderId_side: { orderId: operation.orderId, side: shipment.ownerSide } } });
        const closure = original && await tx.originalShipmentClosure.findUnique({ where: { shipmentId: original.id } });
        if (closure?.outcome !== 'DELIVERED') return false;
      } else if (operation.kind === 'CLOSE_OR_INTERCEPT') {
        const original = await tx.shipment.findUnique({ where: { id: operation.payload.shipmentId as string } });
        if (!original || original.orderId !== operation.orderId || original.businessNo !== operation.payload.originalBusinessNo) return false;
      } else return false;
      if (!await tx.auditLog.count({ where: { action: 'RETURN_LOGISTICS_OPERATION_ADMITTED', entityId: durable.id } })) await this.audit.record(tx, { actorId: null, action: 'RETURN_LOGISTICS_OPERATION_ADMITTED', entityType: 'OutboxCommand', entityId: durable.id, after: { businessNo: operation.businessNo, kind: operation.kind } });
      return true;
    });
  }
  query(operation: ProviderOperation): Promise<ProviderResult> { return operation.kind === 'VERIFY_RETURN' ? this.port.queryReturn(operation) : this.port.queryInterception(operation); }
  async execute(operation: ProviderOperation): Promise<ProviderResult> {
    if (operation.kind === 'VERIFY_RETURN') return this.port.verifyReturn(operation);
    // Read the original business number before initiating an interception. A
    // missing/unknown query is never taken as a proof of no delivery or closure.
    await this.port.queryShipment(operation.payload.originalBusinessNo as string);
    return this.port.closeOrIntercept(operation);
  }
  async apply(operation: ProviderOperation, result: ProviderResult): Promise<void> {
    if (result.status !== 'SUCCESS') return;
    const event = result.event;
    if ((event.kind !== 'RETURN_PROGRESS' && event.kind !== 'ORIGINAL_SHIPMENT_CLOSED') || event.businessNo !== operation.businessNo || event.shipmentId !== operation.payload.shipmentId || result.externalTransactionId !== event.shipmentId || (operation.kind === 'VERIFY_RETURN' ? event.kind !== 'RETURN_PROGRESS' : event.kind !== 'ORIGINAL_SHIPMENT_CLOSED')) throw new Error('Return provider result does not match the operation');
    await this.events.applyVerified(event);
  }
}
