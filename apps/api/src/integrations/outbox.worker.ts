import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import { OutboxHandlerRegistry } from './outbox-handler.registry.js';
import type { OutboxCommand, Prisma } from '../generated/prisma/client.js';
import type { IntegrationOperationHandler, ProviderOperation, ProviderResult } from './integration.types.js';

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopped = false;
  private readonly logger = new Logger(OutboxWorker.name);
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(CLOCK) private readonly clock: Clock, @Inject(OutboxHandlerRegistry) private readonly registry: OutboxHandlerRegistry) {}
  onModuleInit(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick().catch(() => this.logger.error('Outbox tick failed; durable commands remain available for reconciliation')); }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.active) return this.active;
    this.active = this.dispatch();
    try { await this.active; } finally { this.active = undefined; }
  }
  private async dispatch(): Promise<void> {
    const now = this.clock.now(); const owner = randomUUID();
    // One atomic statement: its row lock/implicit transaction ends before any handler I/O.
    const [command] = await this.prisma.$queryRaw<OutboxCommand[]>`
      WITH candidate AS (
        SELECT id FROM "OutboxCommand"
        WHERE (status IN ('PENDING', 'UNKNOWN') AND "availableAt" <= ${now})
           OR (status = 'PROCESSING' AND "leaseExpiresAt" <= ${now})
        ORDER BY "availableAt", "createdAt", id FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "OutboxCommand" AS command SET status = 'PROCESSING', "leaseOwner" = ${owner},
        "leaseExpiresAt" = ${new Date(now.getTime() + 30000)}, attempts = attempts + 1, "updatedAt" = ${now}
      FROM candidate WHERE command.id = candidate.id RETURNING command.*`;
    if (!command) return;
    const operation: ProviderOperation = { businessNo: command.businessNo, orderId: command.orderId, kind: command.kind, payload: command.payload as Prisma.InputJsonObject };
    const handler = this.registry.get(command.kind);
    if (!handler) { await this.finish(command, owner, { status: 'UNKNOWN' }, 'HANDLER_UNAVAILABLE'); return; }
    try {
      const admitted = await this.authorized(handler, operation);
      // Authorization affects sending only. Even a held/cancelled order needs facts.
      const result = await handler.query(operation);
      if (!await this.owns(command.id, owner)) return;
      if (result.status === 'FAILURE' && result.reason === 'NOT_FOUND') {
        if (!admitted || !await this.authorized(handler, operation)) {
          await this.finish(command, owner, { status: 'PENDING' }, 'EXECUTION_NOT_AUTHORIZED'); return;
        }
        // Authorization is the final awaited gate before sending. Admission is
        // durable in the handler's short transaction; no order lock spans I/O.
        if (this.clock.now().getTime() >= command.leaseExpiresAt!.getTime()) return;
        const executed = await handler.execute(operation);
        if (!await this.owns(command.id, owner)) return;
        await handler.apply(operation, executed);
        await this.finish(command, owner, executed);
      } else {
        await handler.apply(operation, result);
        await this.finish(command, owner, result);
      }
    } catch {
      // Do not persist provider exception bodies, credentials, or private payloads.
      await this.finish(command, owner, { status: 'UNKNOWN' }, 'PROVIDER_OR_APPLY_ERROR');
    }
  }
  private async authorized(handler: IntegrationOperationHandler, operation: ProviderOperation): Promise<boolean> {
    try { return await handler.authorize?.(operation) === true; } catch { return false; }
  }
  private async owns(id: string, owner: string): Promise<boolean> {
    return (await this.prisma.outboxCommand.count({ where: { id, status: 'PROCESSING', leaseOwner: owner, leaseExpiresAt: { gt: this.clock.now() } } })) === 1;
  }
  private async finish(command: OutboxCommand, owner: string, result: ProviderResult, lastError: string | null = null): Promise<void> {
    const now = this.clock.now();
    await this.prisma.outboxCommand.updateMany({
      where: { id: command.id, status: 'PROCESSING', leaseOwner: owner, leaseExpiresAt: { gt: now } },
      data: {
        status: result.status === 'SUCCESS' ? 'SUCCEEDED' : result.status === 'FAILURE' ? 'FAILED' : result.status,
        result: result as unknown as Prisma.InputJsonObject, lastError,
        availableAt: new Date(now.getTime() + 30000), leaseOwner: null, leaseExpiresAt: null,
      },
    });
  }
}
