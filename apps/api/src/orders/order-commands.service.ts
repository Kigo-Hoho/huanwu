import { createHash } from 'node:crypto';
import { OrderCommandResultSchema, type OrderCommandInput, type OrderCommandResult } from '@barter/contracts';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { assertPureCustomer } from '../auth/customer-only.guard.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { IdempotencyRecord, Prisma } from '../generated/prisma/client.js';
import { dueDeadline } from './order-policy.js';
import { mapOrder, type LockedOrder, type OrderTx } from './order.mapper.js';
import { readOrder } from './order-reader.js';
export type { LockedOrder, OrderTx } from './order.mapper.js';

export interface OrderCommandContext { actor: AuthenticatedUser; id: string; input: OrderCommandInput; key: string; commandName: string; requestId?: string; admissionIntentId?: string }
export type OrderMutation = (tx: OrderTx, order: LockedOrder, now: Date) => Promise<{ auditAction: string; paymentIntentId?: string }>;
export function orderRequestHash(id: string, input: OrderCommandInput): string {
  const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalize(entry)])) : value;
  return createHash('sha256').update(JSON.stringify(canonicalize({ id, input }))).digest('hex');
}
export function replayOrderCommand(previous: IdempotencyRecord, requestHash: string): OrderCommandResult {
  if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was used with different content' });
  return OrderCommandResultSchema.parse(previous.response);
}
export function assertOrderParticipant(order: LockedOrder | null, actorId: string): asserts order is LockedOrder {
  if (!order || (order.initiatorId !== actorId && order.recipientId !== actorId)) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order was not found' });
}
export function uniqueConflict(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'; }

@Injectable()
export class OrderCommandsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(AuditService) private readonly audit: AuditService, @Inject(CLOCK) private readonly clock: Clock) {}
  async execute(context: OrderCommandContext, mutate: OrderMutation): Promise<OrderCommandResult> {
    const { actor, id, input, key, commandName, requestId } = context;
    assertPureCustomer(actor);
    const requestHash = orderRequestHash(id, input);
    const identity = { actorId: actor.id, commandName, key };
    const where = { actorId_commandName_key: identity };
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const order = await readOrder(tx, id);
        assertOrderParticipant(order, actor.id);
        const previous = await tx.idempotencyRecord.findUnique({ where });
        if (previous) {
          if (context.admissionIntentId && previous.requestHash === requestHash && (previous.response as Prisma.JsonObject).status === 'IN_PROGRESS') {
            return { order: mapOrder(order), paymentIntentId: context.admissionIntentId };
          }
          return replayOrderCommand(previous, requestHash);
        }
        await tx.idempotencyRecord.create({ data: { ...identity, requestHash, response: {} } });
        const now = this.clock.now();
        const before = mapOrder(order);
        if (dueDeadline(before, now)) throw new ConflictException({ code: 'ORDER_EXPIRED', message: 'Order command deadline has passed' });
        if (order.version !== input.expectedVersion) throw new ConflictException({ code: 'ORDER_VERSION_CONFLICT', message: 'Order has changed' });
        if (order.status === 'ON_HOLD') throw new ConflictException({ code: 'ORDER_ON_HOLD', message: 'Order is on hold' });
        if (['COMPLETED', 'CANCELLED', 'CANCEL_PENDING', 'SETTLING'].includes(order.status)) throw new ConflictException({ code: 'ORDER_INVALID_STATE', message: 'Order does not allow customer commands' });
        const mutation = await mutate(tx, order, now);
        await tx.order.update({ where: { id }, data: { version: { increment: 1 } } });
        const updated = await readOrder(tx, id);
        assertOrderParticipant(updated, actor.id);
        const result = OrderCommandResultSchema.parse({ order: mapOrder(updated), ...(mutation.paymentIntentId ? { paymentIntentId: mutation.paymentIntentId } : {}) });
        await this.audit.record(tx, { actorId: actor.id, action: mutation.auditAction, entityType: 'Order', entityId: id, requestId, before: before as unknown as Prisma.InputJsonValue, after: result.order as unknown as Prisma.InputJsonValue });
        await tx.idempotencyRecord.update({ where, data: { response: context.admissionIntentId ? { status: 'IN_PROGRESS', orderId: id, intentId: context.admissionIntentId, expectedVersion: input.expectedVersion } : result as unknown as Prisma.InputJsonValue } });
        return result;
      });
    } catch (error) {
      if (!uniqueConflict(error)) throw error;
      const order = await readOrder(this.prisma, id);
      assertOrderParticipant(order, actor.id);
      const previous = await this.prisma.idempotencyRecord.findUnique({ where });
      if (!previous) throw error;
      return replayOrderCommand(previous, requestHash);
    }
  }
}
