import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { ProviderOperation, ProviderResult, VerifiedIntegrationEvent } from './integration.types.js';
import type { IntegrationOperationKind, Prisma, SimulatedProviderOperation } from '../generated/prisma/client.js';
import { INTEGRATION_CONFIG, integrationConfiguration, integrationUnavailable, type IntegrationConfiguration } from './integration-config.js';

const identity = { provider: z.literal('simulated'), eventId: z.string().min(1).max(200), businessNo: z.string().min(1).max(200), occurredAt: z.iso.datetime() };
const money = { amountFen: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: z.literal('CNY') };
const eventSchema = z.union([
  z.object({ ...identity, ...money, currency: z.string().regex(/^[A-Z]{3}$/), kind: z.enum(['PAYMENT_SUCCEEDED', 'PAYMENT_CLOSED', 'REFUND_SUCCEEDED', 'DIFFERENCE_SETTLED']), externalTransactionId: z.string().min(1).max(200) }).strict(),
  z.object({ ...identity, kind: z.literal('SHIPMENT_PROGRESS'), shipmentId: z.uuid(), progress: z.enum(['REGISTERED', 'COLLECTED', 'DELIVERED', 'EXCEPTION']) }).strict(),
]);
const invalid = () => new BadRequestException({ code: 'INTEGRATION_EVENT_INVALID', message: 'Integration event or operation is invalid' });
const conflict = () => new ConflictException({ code: 'INTEGRATION_EVENT_INVALID', message: 'Integration facts conflict with the recorded operation' });
const logistics = (kind: IntegrationOperationKind) => kind === 'VERIFY_SHIPMENT' || kind === 'QUERY_SHIPMENT';
const json = (result: ProviderResult) => result as unknown as Prisma.InputJsonObject;
const resultOf = (row: SimulatedProviderOperation): ProviderResult => row.result as unknown as ProviderResult;

@Injectable()
export class SimulatedProviderStore {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfiguration = integrationConfiguration(),
  ) {}
  assertEnabled(channel: 'payment' | 'logistics'): void { if (this.config[channel] !== 'simulated' || !this.config.signingKey) throw integrationUnavailable(); }
  verifySignedEvent(raw: string, signature: string, channel: 'payment' | 'logistics'): VerifiedIntegrationEvent {
    this.assertEnabled(channel);
    if (Buffer.byteLength(raw) > 8192 || !/^[a-f0-9]{64}$/.test(signature)) throw invalid();
    const expected = createHmac('sha256', this.config.signingKey!).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw invalid();
    try {
      const event = eventSchema.parse(JSON.parse(raw));
      if ((event.kind === 'SHIPMENT_PROGRESS') !== (channel === 'logistics')) throw invalid();
      return event;
    } catch { throw invalid(); }
  }
  async query(businessNo: string, kinds?: readonly IntegrationOperationKind[]): Promise<ProviderResult> {
    const row = await this.prisma.simulatedProviderOperation.findUnique({ where: { businessNo } });
    if (!row) return { status: 'FAILURE', reason: 'NOT_FOUND' };
    this.assertEnabled(logistics(row.kind) ? 'logistics' : 'payment');
    if (kinds && !kinds.includes(row.kind)) return { status: 'FAILURE', reason: 'OPERATION_KIND_MISMATCH' };
    return resultOf(row);
  }
  async execute(operation: ProviderOperation): Promise<ProviderResult> {
    this.assertEnabled(logistics(operation.kind) ? 'logistics' : 'payment');
    const payment = z.object(money).safeParse(operation.payload);
    if (!z.uuid().safeParse(operation.orderId).success || !operation.businessNo || operation.businessNo.length > 200) throw invalid();
    if (logistics(operation.kind)) {
      if (!z.object({ shipmentId: z.uuid(), carrier: z.string().min(1), trackingNumber: z.string().min(1) }).safeParse(operation.payload).success) throw invalid();
    } else if (!payment.success) throw invalid();
    const isEffect = !logistics(operation.kind) && operation.kind !== 'CREATE_PAYMENT';
    const paymentBusinessNo = operation.payload.paymentBusinessNo;
    if (isEffect && (typeof paymentBusinessNo !== 'string' || !paymentBusinessNo || paymentBusinessNo === operation.businessNo)) throw invalid();
    // This ALWAYS uses the root client. No caller order transaction is accepted.
    return this.prisma.$transaction(async tx => {
      if (isEffect) await tx.$queryRaw`SELECT id FROM "SimulatedProviderOperation" WHERE "businessNo" = ${paymentBusinessNo as string} FOR UPDATE`;
      const inserted = await tx.simulatedProviderOperation.createMany({ data: [{ ...operation, provider: 'simulated', result: json({ status: 'PENDING' }) }], skipDuplicates: true });
      const row = await tx.simulatedProviderOperation.findUniqueOrThrow({ where: { businessNo: operation.businessNo } });
      if (row.orderId !== operation.orderId || row.kind !== operation.kind || !isDeepStrictEqual(row.payload, operation.payload)) throw conflict();
      if (!inserted.count || !isEffect) return resultOf(row);
      const source = await tx.simulatedProviderOperation.findUnique({ where: { businessNo: paymentBusinessNo as string } });
      const sourcePayload = source?.payload as Prisma.JsonObject | undefined;
      let result: ProviderResult;
      if (!source || source.kind !== 'CREATE_PAYMENT' || source.orderId !== operation.orderId || sourcePayload?.amountFen !== operation.payload.amountFen || sourcePayload?.currency !== operation.payload.currency) {
        result = { status: 'FAILURE', reason: 'ORIGINAL_PAYMENT_MISMATCH' };
      } else if (operation.kind === 'CLOSE_PAYMENT') {
        if (source.status !== 'PENDING') result = { status: 'FAILURE', reason: 'PAYMENT_NOT_PENDING' };
        else {
          result = this.financialSuccess(operation, 'PAYMENT_CLOSED');
          await tx.simulatedProviderOperation.update({ where: { id: source.id }, data: { status: 'FAILURE', result: json({ status: 'FAILURE', reason: 'CLOSED' }) } });
        }
      } else if (source.status !== 'SUCCESS') result = { status: 'FAILURE', reason: 'PAYMENT_NOT_PAID' };
      else {
        const effect = await tx.simulatedProviderOperation.findFirst({ where: { kind: { in: ['REFUND_PAYMENT', 'SETTLE_DIFFERENCE'] }, status: 'SUCCESS', payload: { path: ['paymentBusinessNo'], equals: source.businessNo } } });
        result = effect ? { status: 'FAILURE', reason: 'PAYMENT_ALREADY_DISPOSED' } : this.financialSuccess(operation, operation.kind === 'REFUND_PAYMENT' ? 'REFUND_SUCCEEDED' : 'DIFFERENCE_SETTLED');
      }
      await tx.simulatedProviderOperation.update({ where: { id: row.id }, data: { status: result.status, result: json(result), externalTransactionId: result.status === 'SUCCESS' ? result.externalTransactionId : null } });
      return result;
    });
  }
  async successCount(businessNo: string): Promise<number> {
    return this.prisma.simulatedProviderOperation.count({ where: { businessNo, status: 'SUCCESS' } });
  }
  // Used only by a trusted adapter/test driver after signature verification and ownership checks.
  // No Order, PaymentIntent, or ledger mutation belongs in the simulated external service.
  async recordEvent(value: VerifiedIntegrationEvent): Promise<void> {
    const parsed = eventSchema.safeParse(value); if (!parsed.success) throw invalid();
    const event = parsed.data; this.assertEnabled(event.kind === 'SHIPMENT_PROGRESS' ? 'logistics' : 'payment');
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "SimulatedProviderOperation" WHERE "businessNo" = ${event.businessNo} FOR UPDATE`;
      const row = await tx.simulatedProviderOperation.findUnique({ where: { businessNo: event.businessNo } });
      if (!row) throw invalid();
      const payload = row.payload as Prisma.JsonObject;
      if (event.kind === 'SHIPMENT_PROGRESS') {
        if (!logistics(row.kind) || payload.shipmentId !== event.shipmentId) throw conflict();
        const prior = resultOf(row);
        if (prior.status === 'SUCCESS' && prior.event.kind === 'SHIPMENT_PROGRESS') {
          const ranks = { REGISTERED: 0, COLLECTED: 1, DELIVERED: 2, EXCEPTION: 3 };
          if (ranks[event.progress] < ranks[prior.event.progress]) throw conflict();
        }
      } else {
        // Effect confirmations are created by execute; test completion only pays an existing intent.
        if (event.kind !== 'PAYMENT_SUCCEEDED' || row.kind !== 'CREATE_PAYMENT' || payload.amountFen !== event.amountFen || payload.currency !== event.currency || row.status === 'FAILURE') throw conflict();
        if (row.status === 'SUCCESS') {
          if (row.externalTransactionId !== event.externalTransactionId) throw conflict();
          return;
        }
      }
      const externalTransactionId = event.kind === 'SHIPMENT_PROGRESS' ? event.shipmentId : event.externalTransactionId;
      const result: ProviderResult = { status: 'SUCCESS', externalTransactionId, event };
      await tx.simulatedProviderOperation.update({ where: { id: row.id }, data: { status: 'SUCCESS', externalTransactionId, result: json(result) } });
    });
  }
  private financialSuccess(operation: ProviderOperation, kind: 'PAYMENT_CLOSED' | 'REFUND_SUCCEEDED' | 'DIFFERENCE_SETTLED'): ProviderResult {
    const externalTransactionId = randomUUID();
    return { status: 'SUCCESS', externalTransactionId, event: { provider: 'simulated', eventId: randomUUID(), businessNo: operation.businessNo, kind, occurredAt: this.clock.now().toISOString(), externalTransactionId, amountFen: operation.payload.amountFen as number, currency: 'CNY' } };
  }
}
