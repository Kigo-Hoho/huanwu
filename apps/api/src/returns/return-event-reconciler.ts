import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { INTEGRATION_CONFIG, type IntegrationConfiguration } from '../integrations/integration-config.js';
import type { VerifiedIntegrationEvent } from '../integrations/integration.types.js';
import { ReturnEventsService } from './return-events.service.js';

// The simulator acceptance transaction appends facts before acknowledging them.
// No lease or in-memory cursor is a delivery acknowledgement: the domain's
// atomic receipt is the sole checkpoint, so a crash or audit failure is retryable.
@Injectable()
export class ReturnEventReconciler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopped = false;
  private readonly logger = new Logger(ReturnEventReconciler.name);
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(ReturnEventsService) private readonly events: ReturnEventsService, @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfiguration) {}

  private enabled(): boolean { return ['development', 'test'].includes(process.env.NODE_ENV ?? '') && this.config.logistics === 'simulated' && !!this.config.signingKey; }
  onModuleInit(): void {
    if (this.timer || this.stopped || !this.enabled()) return;
    this.timer = setInterval(() => { void this.tick().catch(() => this.logger.error('Return reconciliation failed; accepted events remain pending')); }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  async tick(): Promise<void> {
    if (this.stopped || !this.enabled()) return;
    if (this.active) return this.active;
    this.active = this.dispatch();
    try { await this.active; } finally { this.active = undefined; }
  }
  private async dispatch(): Promise<void> {
    const pending = await this.prisma.$queryRaw<{ payload: unknown }[]>`
      SELECT p.payload FROM "SimulatedProviderEvent" p
      WHERE NOT EXISTS (
        SELECT 1 FROM "IntegrationEvent" e JOIN "IntegrationEventReceipt" r ON r."eventId" = e.id
        WHERE e.provider = p.provider AND e."eventId" = p."eventId" AND r.status IN ('PROCESSED', 'REJECTED')
      ) ORDER BY p.id LIMIT 100`;
    // Multiple processes may select the same fact. applyVerified owns the common
    // order lock and identity constraint; fact+receipt+risk+audit commit once.
    for (const row of pending) {
      if (this.stopped) break;
      try { await this.events.applyVerified(row.payload as VerifiedIntegrationEvent); }
      catch { this.logger.warn('Return event application failed; immutable provider fact remains pending'); }
    }
  }
}
