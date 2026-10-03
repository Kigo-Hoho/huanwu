import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { OrderCommandResultSchema } from '@barter/contracts';
import { createOrderHarness, type OrderHarness } from './support/order-harness.js';
import { OutboxWorker } from '../../src/integrations/outbox.worker.js';
import { OutboxHandlerRegistry } from '../../src/integrations/outbox-handler.registry.js';
import { PaymentsService } from '../../src/payments/payments.service.js';
import { PAYMENT_PORT, type PaymentPort } from '../../src/payments/payment.port.js';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { LocalImageStorageAdapter } from '../../src/storage/local-image-storage.adapter.js';
import { ProposalExpiryScheduler } from '../../src/proposals/proposal-expiry.scheduler.js';
import { configureApp } from '../../src/main.js';

let h: OrderHarness;
const environment = new Map<string, string | undefined>();
beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', PAYMENT_PROVIDER: 'simulated', LOGISTICS_PROVIDER: 'disabled', SIMULATED_INTEGRATION_SIGNING_KEY_BASE64: randomBytes(32).toString('base64') })) {
    environment.set(key, process.env[key]); process.env[key] = value;
  }
  h = await createOrderHarness();
});
afterEach(async () => { vi.restoreAllMocks(); await h.prisma.outboxCommand.updateMany({ where: { status: { in: ['PENDING', 'UNKNOWN', 'PROCESSING'] } }, data: { status: 'UNKNOWN', availableAt: new Date('2099-01-01'), leaseOwner: null, leaseExpiresAt: null } }); });
afterAll(async () => { await h?.close(); for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
async function order(differenceFen = 0, payer: 'NONE' | 'INITIATOR' | 'RECIPIENT' = 'NONE') {
  return OrderCommandResultSchema.parse((await h.convert(await h.confirmedProposal({ mode: 'IN_PERSON', differenceFen, payer })).expect(201)).body).order;
}
const path = (id: string) => `/api/orders/${id}/payments`;
it.each(['INITIATOR', 'RECIPIENT'] as const)('derives both deposits and the %s difference from immutable terms', async payer => {
  const created = await order(2700, payer);
  const first = await h.command(h.actors.initiator, path(created.id), { expectedVersion: 1, purpose: 'DEPOSIT' }).expect(202);
  const second = await h.command(h.actors.recipient, path(created.id), { expectedVersion: 2, purpose: 'DEPOSIT' }).expect(202);
  const actor = payer === 'INITIATOR' ? h.actors.initiator : h.actors.recipient;
  await h.command(actor, path(created.id), { expectedVersion: 3, purpose: 'DIFFERENCE' }).expect(202);
  const intents = await h.prisma.paymentIntent.findMany({ where: { orderId: created.id } });
  expect(intents.filter(intent => intent.purpose === 'DEPOSIT').map(intent => intent.amountFen)).toEqual([1000, 1000]);
  expect(intents.find(intent => intent.purpose === 'DIFFERENCE')).toMatchObject({ side: payer, amountFen: 2700, currency: 'CNY' });
  expect(first.body.paymentIntentId).not.toBe(second.body.paymentIntentId);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: created.id, kind: 'CREATE_PAYMENT' } })).toBe(3);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('AWAITING_PAYMENT');
});
it('rejects zero difference, wrong payer and client financial fields without creating obligations', async () => {
  const zero = await order();
  await h.command(h.actors.initiator, path(zero.id), { expectedVersion: 1, purpose: 'DIFFERENCE' }).expect(409);
  const created = await order(500, 'RECIPIENT');
  await h.command(h.actors.initiator, path(created.id), { expectedVersion: 1, purpose: 'DIFFERENCE' }).expect(403);
  for (const extra of [{ amountFen: 1 }, { currency: 'USD' }, { payerId: h.actors.recipient.id }, { receiverId: h.actors.initiator.id }]) {
    await h.command(h.actors.recipient, path(created.id), { expectedVersion: 1, purpose: 'DEPOSIT', ...extra }).expect(400);
  }
  expect(await h.prisma.paymentIntent.count({ where: { orderId: { in: [zero.id, created.id] } } })).toBe(0);
});
it('replays a stable own obligation and rejects cross-order key reuse, unauthorized roles and stale versions', async () => {
  const created = await order(); const another = await order(); const key = randomUUID(); const input = { expectedVersion: 1, purpose: 'DEPOSIT' };
  const first = await h.command(h.actors.initiator, path(created.id), input, key).expect(202);
  expect((await h.command(h.actors.initiator, path(created.id), input, key).expect(202)).body).toEqual(first.body);
  await h.command(h.actors.initiator, path(another.id), input, key).expect(409).expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_CONFLICT'));
  for (const actor of [h.actors.outsider, h.actors.operator, h.actors.mixed]) await h.command(actor, path(created.id), input).expect(actor === h.actors.outsider ? 404 : 403);
  await h.command(h.actors.recipient, path(created.id), input).expect(409).expect(({ body }) => expect(body.code).toBe('ORDER_VERSION_CONFLICT'));
  const retry = await h.command(h.actors.initiator, path(created.id), { ...input, expectedVersion: 2 }).expect(202);
  expect(retry.body.paymentIntentId).toBe(first.body.paymentIntentId);
  expect(await h.prisma.paymentIntent.count({ where: { orderId: created.id } })).toBe(1);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: created.id } })).toBe(1);
});
it('keeps checkout private and pending without creating a second intent on GET', async () => {
  const created = await order();
  const started = await h.command(h.actors.initiator, path(created.id), { expectedVersion: 1, purpose: 'DEPOSIT' }).expect(202);
  const checkout = `${path(created.id)}/${started.body.paymentIntentId}/checkout`;
  const own = await h.get(h.actors.initiator, checkout).expect(200);
  expect(own.body).toEqual({ status: 'PENDING', paymentIntentId: started.body.paymentIntentId }); expect(own.headers['cache-control']).toBe('no-store');
  await h.get(h.actors.recipient, checkout).expect(403); await h.get(h.actors.outsider, checkout).expect(404);
  expect(await h.prisma.paymentIntent.count({ where: { orderId: created.id } })).toBe(1);
});
it('rolls back intent, outbox, revision and cache when the real initiation audit fails', async () => {
  const created = await order(); const key = randomUUID(); const count = await h.prisma.auditLog.count(); h.faultAuditOnce(true);
  await h.command(h.actors.initiator, path(created.id), { expectedVersion: 1, purpose: 'DEPOSIT' }, key).expect(500);
  expect(await h.prisma.paymentIntent.count({ where: { orderId: created.id } })).toBe(0);
  expect(await h.prisma.outboxCommand.count({ where: { orderId: created.id } })).toBe(0);
  expect(await h.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  expect(await h.prisma.auditLog.count()).toBe(count);
  expect((await h.prisma.order.findUniqueOrThrow({ where: { id: created.id } })).version).toBe(1);
});
it('returns generated checkout only through the payer GET without caching or auditing its params', async () => {
  const created = await order(); const key = randomUUID();
  const started = await h.command(h.actors.initiator, path(created.id), { expectedVersion: 1, purpose: 'DEPOSIT' }, key).expect(202);
  await new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry)).tick();
  const checkout = `${path(created.id)}/${started.body.paymentIntentId}/checkout`;
  const auditCount = await h.prisma.auditLog.count();
  const ready = await h.get(h.actors.initiator, checkout).expect(200);
  expect(ready.body).toMatchObject({ status: 'READY', provider: 'simulated', params: { simulation: 'true' } });
  expect(ready.headers['cache-control']).toBe('no-store');
  await h.get(h.actors.recipient, checkout).expect(403);
  expect(await h.prisma.auditLog.count()).toBe(auditCount);
  const cache = await h.prisma.idempotencyRecord.findFirstOrThrow({ where: { key } });
  expect(JSON.stringify(cache.response)).not.toContain('params');
  expect(JSON.stringify(await h.prisma.auditLog.findMany({ where: { entityId: created.id } }))).not.toContain('params');
});
it('revalidates checkout state after the external await and never returns credentials after cancellation', async () => {
  const created = await order();
  const started = await h.command(h.actors.initiator, path(created.id), { expectedVersion: 1, purpose: 'DEPOSIT' }).expect(202);
  const port = h.app.get<PaymentPort>(PAYMENT_PORT); const checkout = port.checkout!.bind(port);
  vi.spyOn(port, 'checkout').mockImplementation(async businessNo => {
    const result = await checkout(businessNo);
    await h.prisma.order.update({ where: { id: created.id }, data: { status: 'CANCEL_PENDING' } });
    return result;
  });
  await h.get(h.actors.initiator, `${path(created.id)}/${started.body.paymentIntentId}/checkout`).expect(409);
});
it.each(['test', 'production'] as const)('does not register the testing payment route in %s disabled configuration', async nodeEnv => {
  const previous = { NODE_ENV: process.env.NODE_ENV, PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER, WECHAT_IDENTITY_PROVIDER: process.env.WECHAT_IDENTITY_PROVIDER };
  process.env.NODE_ENV = nodeEnv; process.env.PAYMENT_PROVIDER = 'disabled'; process.env.WECHAT_IDENTITY_PROVIDER = 'wechat';
  try {
    const module = await Test.createTestingModule({ imports: [AppModule.forEnvironment()] }).overrideProvider(LocalImageStorageAdapter).useValue({}).overrideProvider(OutboxWorker).useValue({}).overrideProvider(ProposalExpiryScheduler).useValue({}).compile();
    const app = module.createNestApplication(); configureApp(app); await app.init();
    try {
      await request(app.getHttpServer()).post(`/api/testing/payments/${randomUUID()}/complete`).send({ expectedVersion: 1 }).expect(404);
      if (nodeEnv === 'test') {
        const created = await order();
        await expect(app.get(PaymentsService).start(h.actors.initiator, created.id, { expectedVersion: 1, purpose: 'DEPOSIT' }, randomUUID())).rejects.toMatchObject({ status: 503 });
      }
    } finally { await app.close(); }
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
