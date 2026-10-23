import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { INTEGRATION_CONFIG, type IntegrationConfiguration } from '../integrations/integration-config.js';
import type { VerifiedIntegrationEvent } from '../integrations/integration.types.js';
import { PaymentEventsService } from '../payments/payment-events.service.js';
import { CompensationEventsService } from './compensation-events.service.js';
@Injectable()
export class FinancialEventReconciler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopped = false;
  private cursor = 0n;
  private readonly logger = new Logger(FinancialEventReconciler.name);
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(CompensationEventsService) private readonly compensation: CompensationEventsService, @Inject(PaymentEventsService) private readonly payments: PaymentEventsService, @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfiguration) {}
  onModuleInit() { if (this.enabled()) { this.timer = setInterval(() => { void this.tick().catch(() => this.logger.warn('Financial reconciliation remains pending')); }, 1000); this.timer.unref(); } }
  async onModuleDestroy() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.active; }
  private enabled() { return ['development', 'test'].includes(process.env.NODE_ENV ?? '') && this.config.payment === 'simulated' && !!this.config.signingKey; }
  async tick() { if (this.stopped || !this.enabled()) return; if (this.active) return this.active; this.active = this.dispatch(); try { await this.active; } finally { this.active = undefined; } }
  private async dispatch() {
    const rows = await this.prisma.$queryRaw<{ id: bigint; payload: unknown }[]>`
      SELECT p.id,p.payload FROM "SimulatedProviderEvent" p WHERE p.id > ${this.cursor}
      AND p.kind IN ('PAYMENT_SUCCEEDED','PAYMENT_CLOSED','REFUND_SUCCEEDED','DIFFERENCE_SETTLED')
      AND NOT EXISTS (SELECT 1 FROM "IntegrationEvent" e JOIN "IntegrationEventReceipt" r ON r."eventId"=e.id WHERE e.provider=p.provider AND e."eventId"=p."eventId" AND r.status IN ('PROCESSED','REJECTED'))
      ORDER BY p.id LIMIT 100`;
    for (const row of rows) {
      this.cursor = row.id;
      const event = row.payload as VerifiedIntegrationEvent;
      try { await (event.businessNo.startsWith('compensation:') ? this.compensation : this.payments).applyVerified(event); }
      catch { this.logger.warn('Accepted financial fact remains available for retry'); }
    }
    if (rows.length < 100) this.cursor = 0n;
  }
}
