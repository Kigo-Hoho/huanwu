import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { OrderCommandResultSchema } from '@barter/contracts';
import { OutboxService } from '../../src/integrations/outbox.service.js';
import { OutboxWorker } from '../../src/integrations/outbox.worker.js';
import { OutboxHandlerRegistry } from '../../src/integrations/outbox-handler.registry.js';
import { SimulatedProviderStore } from '../../src/integrations/simulated-provider.store.js';
import { SimulatedPaymentAdapter } from '../../src/integrations/simulated-payment.adapter.js';
import { SimulatedLogisticsAdapter } from '../../src/integrations/simulated-logistics.adapter.js';
import { PAYMENT_PORT, type PaymentPort } from '../../src/payments/payment.port.js';
import type { IntegrationOperationHandler, ProviderOperation, ProviderResult } from '../../src/integrations/integration.types.js';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';

let h: OrderHarness;
let outbox: OutboxService;
let store: SimulatedProviderStore;
const signingKey = randomBytes(32);
const environment = new Map<string, string | undefined>();
beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', PAYMENT_PROVIDER: 'simulated', LOGISTICS_PROVIDER: 'simulated', SIMULATED_INTEGRATION_SIGNING_KEY_BASE64: signingKey.toString('base64') })) {
    environment.set(key, process.env[key]); process.env[key] = value;
  }
  h = await createOrderHarness(); outbox = h.app.get(OutboxService); store = h.app.get(SimulatedProviderStore);
});
afterAll(async () => {
  await h?.close();
  for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
afterEach(async () => {
  // Each test owns its rows; park unfinished commands so the next scenario is isolated.
  await h.prisma.outboxCommand.updateMany({ where: { status: { in: ['PENDING', 'UNKNOWN', 'PROCESSING'] } }, data: { status: 'UNKNOWN', availableAt: new Date('2099-01-01'), leaseOwner: null, leaseExpiresAt: null } });
});
async function operation(kind: ProviderOperation['kind'] = 'SETTLE_DIFFERENCE') {
  const order = OrderCommandResultSchema.parse((await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON' })).expect(201)).body).order;
  return externalOperation(order.id, kind);
}
async function externalOperation(orderId: string, kind: ProviderOperation['kind'] = 'SETTLE_DIFFERENCE') {
  const op: ProviderOperation = { businessNo: randomUUID(), orderId, kind, payload: { amountFen: 1000, currency: 'CNY' } };
  if (kind === 'SETTLE_DIFFERENCE' || kind === 'REFUND_PAYMENT' || kind === 'CLOSE_PAYMENT') {
    const payment: ProviderOperation = { ...op, businessNo: randomUUID(), kind: 'CREATE_PAYMENT' };
    await store.execute(payment);
    if (kind !== 'CLOSE_PAYMENT') await paid(payment);
    op.payload = { ...op.payload, paymentBusinessNo: payment.businessNo };
  }
  return op;
}
function signed(event: object) {
  const raw = JSON.stringify(event); const signature = createHmac('sha256', signingKey).update(raw).digest('hex');
  return h.app.get(SimulatedPaymentAdapter).verifySignedEvent(raw, signature);
}
async function paid(op: ProviderOperation) {
  await store.recordEvent(signed({ provider: 'simulated', eventId: randomUUID(), kind: 'PAYMENT_SUCCEEDED', businessNo: op.businessNo, occurredAt: h.clock.now().toISOString(), externalTransactionId: randomUUID(), amountFen: 1000, currency: 'CNY' }));
}
function handler(): IntegrationOperationHandler {
  return { authorize: async () => true, query: op => store.query(op.businessNo), execute: op => store.execute(op), apply: async () => {} };
}
function worker(value: IntegrationOperationHandler = handler()) {
  const registry = new OutboxHandlerRegistry(); registry.register('SETTLE_DIFFERENCE', value);
  return new OutboxWorker(h.prisma, h.clock, registry);
}
async function enqueue(op: ProviderOperation) { return h.prisma.$transaction(tx => outbox.enqueue(tx, op)); }
async function row(op: ProviderOperation) { return h.prisma.outboxCommand.findUniqueOrThrow({ where: { businessNo: op.businessNo } }); }
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

it('enqueues once in the caller transaction and rejects reuse for different content', async () => {
  const op = await operation();
  await Promise.all([enqueue(op), enqueue(op)]);
  expect(await h.prisma.outboxCommand.count({ where: { businessNo: op.businessNo } })).toBe(1);
  await expect(enqueue({ ...op, payload: { amountFen: 2000, currency: 'CNY' } })).rejects.toThrow();
  const rolledBack = { ...op, businessNo: randomUUID() };
  await expect(h.prisma.$transaction(async tx => { await outbox.enqueue(tx, rolledBack); throw new Error('rollback'); })).rejects.toThrow('rollback');
  expect(await h.prisma.outboxCommand.count({ where: { businessNo: rolledBack.businessNo } })).toBe(0);
});
it('queries the same number before execution, claims once across workers, and releases DB locks before the provider', async () => {
  const op = await operation(); await enqueue(op);
  const entered = barrier(); const resume = barrier(); const calls: string[] = [];
  const value = handler();
  value.query = async current => {
    calls.push(`query:${current.businessNo}`);
    await h.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${op.orderId}::uuid FOR UPDATE NOWAIT`;
      await tx.$queryRaw`SELECT id FROM "OutboxCommand" WHERE "businessNo" = ${op.businessNo} FOR UPDATE NOWAIT`;
    });
    entered.release(); await resume.promise; return store.query(current.businessNo);
  };
  value.execute = async current => { calls.push(`execute:${current.businessNo}`); return store.execute(current); };
  const first = worker(value).tick(); await entered.promise;
  try { await worker(value).tick(); expect((await row(op)).attempts).toBe(1); }
  finally { resume.release(); await first; }
  expect(calls).toEqual([`query:${op.businessNo}`, `execute:${op.businessNo}`]);
  expect((await row(op)).status).toBe('SUCCEEDED'); expect(await store.successCount(op.businessNo)).toBe(1);
});
it('recovers an expired lease at exactly 30 seconds and queries a preexisting external success without executing', async () => {
  const op = await operation(); const command = await enqueue(op); await store.execute(op);
  await h.prisma.outboxCommand.update({ where: { id: command.id }, data: { status: 'PROCESSING', leaseOwner: 'dead-worker', leaseExpiresAt: new Date(h.clock.now().getTime() + 30000) } });
  const value = handler(); value.execute = async () => { throw new Error('must not resend success'); };
  h.clock.advance(29999); await worker(value).tick(); expect((await row(op)).status).toBe('PROCESSING');
  h.clock.advance(1); await worker(value).tick(); expect((await row(op)).status).toBe('SUCCEEDED');
  expect(await store.successCount(op.businessNo)).toBe(1);
});
it('reconciles external success after local apply failure and recreated store/worker without repeating the effect', async () => {
  const op = await operation(); await enqueue(op);
  const failed = handler(); failed.apply = async () => { throw new Error('local audit failed'); };
  await worker(failed).tick(); expect((await row(op)).status).toBe('UNKNOWN');
  expect(await store.successCount(op.businessNo)).toBe(1);
  const restarted = new SimulatedProviderStore(h.prisma, h.clock);
  const recovered = handler(); recovered.query = current => restarted.query(current.businessNo);
  recovered.execute = async () => { throw new Error('must not resend success'); };
  h.clock.advance(30000); await worker(recovered).tick();
  expect((await row(op)).status).toBe('SUCCEEDED'); expect(await restarted.successCount(op.businessNo)).toBe(1);
});
it.each(['UNKNOWN', 'PENDING'] as const)('reconciles %s every 30 seconds without resending', async status => {
  const op = await operation(); await enqueue(op); let queries = 0;
  const value = handler(); value.query = async () => { queries++; return { status }; };
  value.execute = async () => { throw new Error('unsafe resend'); };
  await worker(value).tick(); h.clock.advance(29999); await worker(value).tick(); expect(queries).toBe(1);
  h.clock.advance(1); await worker(value).tick(); expect(queries).toBe(2);
  expect(await store.successCount(op.businessNo)).toBe(0); expect((await row(op)).status).toBe(status);
  // Keep unfinished commands from participating in later tests.
  await h.prisma.outboxCommand.update({ where: { businessNo: op.businessNo }, data: { availableAt: new Date('2099-01-01') } });
});
it('uses explicit NOT_FOUND to retry the original operation, never a new business number', async () => {
  const op = await operation(); await enqueue(op);
  const value = handler(); value.execute = async () => { throw new Error('transport timeout'); };
  await worker(value).tick(); expect((await row(op)).status).toBe('UNKNOWN');
  h.clock.advance(30000); await worker().tick();
  expect((await row(op)).status).toBe('SUCCEEDED'); expect(await store.successCount(op.businessNo)).toBe(1);
});
it('persists simulated external success independently of a rolled-back order transaction and without an Order foreign key', async () => {
  const op = await externalOperation(randomUUID());
  await expect(h.prisma.$transaction(async () => { await store.execute(op); throw new Error('rollback'); })).rejects.toThrow('rollback');
  expect(await new SimulatedProviderStore(h.prisma, h.clock).successCount(op.businessNo)).toBe(1);
  await Promise.all([store.execute(op), store.execute(op)]);
  expect(await store.successCount(op.businessNo)).toBe(1);
  await expect(store.execute({ ...op, payload: { amountFen: 2000, currency: 'CNY' } })).rejects.toThrow();
});
it('keeps unregistered operation kinds explicitly unavailable', async () => {
  const op = await operation('REFUND_PAYMENT'); await enqueue(op); await worker().tick();
  expect(await store.successCount(op.businessNo)).toBe(0);
  expect(await row(op)).toMatchObject({ status: 'UNKNOWN', lastError: 'HANDLER_UNAVAILABLE' });
  await h.prisma.outboxCommand.update({ where: { businessNo: op.businessNo }, data: { availableAt: new Date('2099-01-01') } });
});
it('applies known success even when fresh execution is no longer authorized', async () => {
  const op = await operation(); await enqueue(op); await store.execute(op); let applied: ProviderResult | undefined;
  const value = handler(); value.authorize = async () => false; value.apply = async (_op, result) => { applied = result; };
  await worker(value).tick(); expect(applied?.status).toBe('SUCCESS'); expect((await row(op)).status).toBe('SUCCEEDED');
});
it.each(['denied', 'missing', 'revoked-during-query'] as const)('does not execute NOT_FOUND when authorization is %s', async mode => {
  const op = await operation(); await enqueue(op); const value = handler(); let checks = 0;
  if (mode === 'missing') delete value.authorize;
  else value.authorize = async () => { checks++; return mode === 'revoked-during-query' && checks === 1; };
  await worker(value).tick(); expect(await store.successCount(op.businessNo)).toBe(0);
  expect(await row(op)).toMatchObject({ status: 'PENDING', lastError: 'EXECUTION_NOT_AUTHORIZED' });
  await h.prisma.outboxCommand.update({ where: { businessNo: op.businessNo }, data: { availableAt: new Date('2099-01-01') } });
});
it('does not let a stale lease execute or overwrite the recovered worker result', async () => {
  const op = await operation(); await enqueue(op); const entered = barrier(); const resume = barrier();
  const value = handler(); value.query = async () => { entered.release(); await resume.promise; return { status: 'FAILURE', reason: 'NOT_FOUND' }; };
  const first = worker(value).tick(); await entered.promise;
  try { h.clock.advance(30000); await worker().tick(); }
  finally { resume.release(); await first; }
  expect((await row(op)).status).toBe('SUCCEEDED'); expect(await store.successCount(op.businessNo)).toBe(1);
});
it('skips a locked oldest command and claims another without waiting for that transaction', async () => {
  const first = await operation(); const next = await operation(); await enqueue(first); await enqueue(next);
  const entered = barrier(); const release = barrier();
  const locked = h.prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "OutboxCommand" WHERE "businessNo" = ${first.businessNo} FOR UPDATE`;
    entered.release(); await release.promise;
  });
  await entered.promise;
  try { await worker().tick(); expect((await row(next)).status).toBe('SUCCEEDED'); expect((await row(first)).attempts).toBe(0); }
  finally { release.release(); await locked; }
});
it('exposes configured ports and leaves payment creation pending until a signed external event', async () => {
  const port = h.app.get<PaymentPort>(PAYMENT_PORT); const op = await operation('CREATE_PAYMENT');
  expect((await port.createPayment(op)).status).toBe('PENDING'); expect(await store.successCount(op.businessNo)).toBe(0);
  const adapter = h.app.get(SimulatedPaymentAdapter);
  const raw = JSON.stringify({ provider: 'simulated', eventId: randomUUID(), kind: 'PAYMENT_SUCCEEDED', businessNo: op.businessNo, occurredAt: h.clock.now().toISOString(), externalTransactionId: randomUUID(), amountFen: 1000, currency: 'CNY' });
  const signature = createHmac('sha256', signingKey).update(raw).digest('hex');
  const event = adapter.verifySignedEvent(raw, signature); await store.recordEvent(event);
  expect((await port.queryPayment(op.businessNo)).status).toBe('SUCCESS'); expect(await store.successCount(op.businessNo)).toBe(1);
  expect(() => adapter.verifySignedEvent(raw, '00'.repeat(32))).toThrow();
  expect(() => h.app.get(SimulatedLogisticsAdapter).verifySignedEvent(raw, signature)).toThrow();
});
it('rejects unpaid, unknown, and mismatched original payment effects without claiming external success', async () => {
  const source = await externalOperation(randomUUID(), 'CREATE_PAYMENT'); await store.execute(source);
  const refund: ProviderOperation = { ...source, businessNo: randomUUID(), kind: 'REFUND_PAYMENT', payload: { ...source.payload, paymentBusinessNo: source.businessNo } };
  expect((await store.execute(refund)).status).toBe('FAILURE');
  await paid(source);
  for (const change of [{ orderId: randomUUID() }, { payload: { ...refund.payload, amountFen: 999 } }, { payload: { ...refund.payload, paymentBusinessNo: randomUUID() } }]) {
    expect((await store.execute({ ...refund, ...change, businessNo: randomUUID() })).status).toBe('FAILURE');
  }
  expect(await store.successCount(refund.businessNo)).toBe(0);
});
it('serializes refund versus settlement and prevents a second effect with a different operation number', async () => {
  const refund = await externalOperation(randomUUID(), 'REFUND_PAYMENT');
  const settlement = { ...refund, businessNo: randomUUID(), kind: 'SETTLE_DIFFERENCE' } satisfies ProviderOperation;
  const results = await Promise.all([store.execute(refund), store.execute(settlement)]);
  expect(results.map(value => value.status).sort()).toEqual(['FAILURE', 'SUCCESS']);
  const winner = results[0].status === 'SUCCESS' ? refund : settlement;
  expect((await store.execute(winner)).status).toBe('SUCCESS');
  expect((await store.execute({ ...winner, businessNo: randomUUID() })).status).toBe('FAILURE');
});
it('closes a pending payment durably without inventing a refund or permitting a normal later completion', async () => {
  const close = await externalOperation(randomUUID(), 'CLOSE_PAYMENT');
  expect((await store.execute(close)).status).toBe('SUCCESS');
  const original = { ...close, kind: 'CREATE_PAYMENT', businessNo: String(close.payload.paymentBusinessNo) } satisfies ProviderOperation;
  expect(await store.query(original.businessNo)).toEqual({ status: 'FAILURE', reason: 'CLOSED' });
  await expect(paid(original)).rejects.toThrow();
  expect(await new SimulatedProviderStore(h.prisma, h.clock).query(original.businessNo)).toEqual({ status: 'FAILURE', reason: 'CLOSED' });
});
it('query ports cannot interpret an unrelated payment or shipment operation as their own result', async () => {
  const op = await operation('CREATE_PAYMENT'); const payment = h.app.get(SimulatedPaymentAdapter); await payment.createPayment(op);
  expect(await payment.queryRefund(op.businessNo)).toEqual({ status: 'FAILURE', reason: 'OPERATION_KIND_MISMATCH' });
  expect(await payment.querySettlement(op.businessNo)).toEqual({ status: 'FAILURE', reason: 'OPERATION_KIND_MISMATCH' });
  expect(await h.app.get(SimulatedLogisticsAdapter).queryShipment(op.businessNo)).toEqual({ status: 'FAILURE', reason: 'OPERATION_KIND_MISMATCH' });
});
it('shipment verification stays pending until signed progress and does not regress on older facts', async () => {
  const adapter = h.app.get(SimulatedLogisticsAdapter);
  const op: ProviderOperation = { businessNo: randomUUID(), orderId: randomUUID(), kind: 'VERIFY_SHIPMENT', payload: { shipmentId: randomUUID(), carrier: 'TEST', trackingNumber: 'TEST1234' } };
  expect((await adapter.verifyShipment(op)).status).toBe('PENDING');
  const event = { provider: 'simulated', eventId: randomUUID(), kind: 'SHIPMENT_PROGRESS', businessNo: op.businessNo, occurredAt: h.clock.now().toISOString(), shipmentId: op.payload.shipmentId, progress: 'DELIVERED' };
  const verify = (value: object) => { const raw = JSON.stringify(value); return adapter.verifySignedEvent(raw, createHmac('sha256', signingKey).update(raw).digest('hex')); };
  await store.recordEvent(verify(event));
  await expect(store.recordEvent(verify({ ...event, eventId: randomUUID(), progress: 'COLLECTED' }))).rejects.toThrow();
  expect(await adapter.queryShipment(op.businessNo)).toMatchObject({ status: 'SUCCESS', event: { progress: 'DELIVERED' } });
  const malformed = { ...event, shipmentId: 'invalid' }; expect(() => verify(malformed)).toThrow();
  const wrongAmount = { provider: 'simulated', eventId: randomUUID(), kind: 'PAYMENT_SUCCEEDED', businessNo: randomUUID(), occurredAt: h.clock.now().toISOString(), externalTransactionId: randomUUID(), amountFen: 0, currency: 'CNY' };
  expect(() => signed(wrongAmount)).toThrow();
  expect(() => signed({ ...wrongAmount, amountFen: 1000, currency: 'USD' })).toThrow();
});
