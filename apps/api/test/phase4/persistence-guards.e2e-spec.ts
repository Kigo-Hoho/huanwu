import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';

let h: AfterSalesHarness;
let client: pg.Client;
beforeAll(async () => {
  h = await createAfterSalesHarness();
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
});
afterAll(async () => { try { await client?.end(); } finally { await h?.close(); } });

const components = (amountFen = 0, payer = 'NONE') => ({ originalDifferenceReversal: { amountFen, payer }, initiatorExtraFen: 0, recipientExtraFen: 0, initiatorShippingFen: 0, recipientShippingFen: 0 });
async function caseFixture(orderId?: string, root = randomUUID(), payer: 'INITIATOR' | 'RECIPIENT' = 'INITIATOR') {
  orderId ??= (await h.prepareOrder({ mode: 'IN_PERSON', differenceFen: 20000, payer })).id;
  const caseId = randomUUID();
  await client.query(`INSERT INTO "AfterSalesCase" (id,"orderId","rootDisputeId","applicantId",reason,status,"closedAt","updatedAt") VALUES ($1,$2,$3,$4,'guard fixture','RESOLVED',now(),now())`, [caseId, orderId, root, h.actors.initiator.id]);
  return { orderId, caseId, root };
}
type Fixture = Awaited<ReturnType<typeof caseFixture>>;
async function resolution(f: Fixture, changes: Record<string, unknown> = {}) {
  const id = randomUUID();
  const snapshots = await h.prisma.orderItemSnapshot.findMany({ where: { orderId: f.orderId } });
  await client.query(`INSERT INTO "ResolutionVersion" (id,"caseId",number,"authorId",type,reason,"rulesVersion","itemSnapshotIds",responsibility,"originalFunds","returnPlan","compensationComponents","netCompensationFen","compensationPayer","orderOutcome") VALUES ($1,$2,$3,$4,'FUNDS_ONLY','guard fixture','phase4-v1',$5,'INITIATOR',$6,'[]',$7,$8,$9,'PRESERVE_TERMINAL')`, [id, f.caseId, changes.number ?? 1, h.actors.operations.id, snapshots.map(snapshot => snapshot.id), JSON.stringify(changes.originalFunds ?? []), JSON.stringify(changes.compensationComponents ?? components()), changes.netCompensationFen ?? 0, changes.compensationPayer ?? 'NONE']);
  return id;
}
// Establish real immutable original-payment facts, rather than treating an
// agreed order difference or a mutable PAID status as proof of settlement.
async function originalPayment(orderId: string, purpose = 'DIFFERENCE', settled = true, side = 'INITIATOR', facts: { collection?: boolean; settlementAmount?: number } = {}) {
  const id = randomUUID(); const businessNo = `original:${id}`;
  await client.query(`INSERT INTO "PaymentIntent" (id,"orderId",side,purpose,"amountFen","businessNo",provider,status,"paidAt","updatedAt") VALUES ($1,$2,$5,$3,20000,$4,'simulated','PAID',now(),now())`, [id, orderId, purpose, businessNo, side]);
  const kinds = [...(facts.collection === false ? [] : ['PAYMENT']), ...(settled ? ['DIFFERENCE_SETTLEMENT'] : [])];
  for (const kind of kinds) {
    const event = randomUUID(); const external = randomUUID();
    const business = kind === 'PAYMENT' ? businessNo : `settle:${id}`;
    await client.query(`INSERT INTO "IntegrationEvent" (id,provider,"eventId",kind,"businessNo","occurredAt","externalTransactionId","amountFen",currency,payload) VALUES ($1,'simulated',$2,$3,$4,now(),$5,20000,'CNY','{}')`, [event, randomUUID(), kind === 'PAYMENT' ? 'PAYMENT_SUCCEEDED' : 'DIFFERENCE_SETTLED', business, external]);
    await client.query(`INSERT INTO "FinancialEntry" (id,"intentId","integrationEventId","entryType",provider,"externalTransactionId","businessNo","amountFen","occurredAt") VALUES ($1,$2,$3,$4,'simulated',$5,$6,$7,now())`, [randomUUID(), id, event, kind, external, business, kind === 'PAYMENT' ? 20000 : facts.settlementAmount ?? 20000]);
  }
  return id;
}
async function obligation(f: Fixture, resolutionId: string, originalPaymentIntentId: string | null = null, amount = 20000, payer = 'RECIPIENT') {
  const id = randomUUID();
  await client.query(`INSERT INTO "CompensationObligation" (id,"resolutionId","rootDisputeId","executionStep","payerSide","payeeSide","amountFen","originalPaymentIntentId","paymentDeadline") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '72 hours')`, [id, resolutionId, f.root, randomUUID(), payer, payer === 'INITIATOR' ? 'RECIPIENT' : 'INITIATOR', amount, originalPaymentIntentId]);
  return id;
}

const invalidReversals: [string, Record<string, unknown>][] = [
  ['positive null payer', { amountFen: 20000, payer: null }], ['zero null payer', { amountFen: 0, payer: null }],
  ['missing payer', { amountFen: 0 }], ['numeric payer', { amountFen: 0, payer: 0 }], ['object payer', { amountFen: 0, payer: {} }],
  ['null amount', { amountFen: null, payer: 'NONE' }], ['missing amount', { payer: 'NONE' }],
  ['string amount', { amountFen: '0', payer: 'NONE' }], ['object amount', { amountFen: {}, payer: 'NONE' }], ['boolean amount', { amountFen: false, payer: 'NONE' }],
];
it.each(invalidReversals)('rejects JSON reversal %s at the database boundary', async (_name, reversal) => {
  const f = await caseFixture();
  await expect(resolution(f, { compensationComponents: { ...components(), originalDifferenceReversal: reversal }, netCompensationFen: reversal.amountFen === 20000 ? 20000 : 0, compensationPayer: reversal.amountFen === 20000 ? 'INITIATOR' : 'NONE' })).rejects.toMatchObject({ code: '23514' });
});
it.each(['initiatorExtraFen', 'recipientExtraFen', 'initiatorShippingFen', 'recipientShippingFen'])('rejects JSON null in %s', async field => {
  const f = await caseFixture();
  await expect(resolution(f, { compensationComponents: { ...components(), [field]: null } })).rejects.toMatchObject({ code: '23514' });
});
it.each(['null destination', 'missing destination', 'numeric destination', 'object destination', 'null paymentIntentId', 'missing paymentIntentId', 'numeric paymentIntentId', 'object paymentIntentId'])('rejects original funds %s with an otherwise real payment reference', async name => {
  const f = await caseFixture(); const paymentIntentId = await originalPayment(f.orderId);
  const plan: Record<string, unknown> = { paymentIntentId, destination: 'REFUND_PAYER' };
  const field = name.includes('destination') ? 'destination' : 'paymentIntentId';
  if (name.startsWith('missing')) delete plan[field];
  else plan[field] = name.startsWith('null') ? null : name.startsWith('numeric') ? 1 : {};
  await expect(resolution(f, { originalFunds: [plan] })).rejects.toMatchObject({ code: '23514' });
});
it.each(['RETAIN_FOR_EXCHANGE', 'REFUND_PAYER', 'SETTLE_BENEFICIARY'])('retains explicit %s and zero NONE plans', async destination => {
  const f = await caseFixture(); const paymentIntentId = await originalPayment(f.orderId);
  await expect(resolution(f, { originalFunds: [{ paymentIntentId, destination }] })).resolves.toEqual(expect.any(String));
});

it.each(['missing', 'null', 'foreign order', 'deposit', 'unsettled', 'uncollected', 'mismatched settlement', 'wrong direction'])('rejects positive reversal with %s original source', async kind => {
  const f = await caseFixture();
  let source: string | null = null;
  if (kind === 'foreign order') source = await originalPayment((await caseFixture()).orderId);
  if (kind === 'deposit') source = await originalPayment(f.orderId, 'DEPOSIT');
  if (kind === 'unsettled') source = await originalPayment(f.orderId, 'DIFFERENCE', false);
  if (kind === 'uncollected') source = await originalPayment(f.orderId, 'DIFFERENCE', true, 'INITIATOR', { collection: false });
  if (kind === 'mismatched settlement') source = await originalPayment(f.orderId, 'DIFFERENCE', true, 'INITIATOR', { settlementAmount: 19999 });
  if (kind === 'wrong direction') source = await originalPayment(f.orderId);
  const payer = kind === 'wrong direction' ? 'INITIATOR' : 'RECIPIENT';
  const r = await resolution(f, { compensationComponents: components(20000, payer), netCompensationFen: 20000, compensationPayer: payer });
  if (kind === 'missing') {
    await expect(client.query(`INSERT INTO "CompensationObligation" (id,"resolutionId","rootDisputeId","executionStep","payerSide","payeeSide","amountFen","paymentDeadline") VALUES ($1,$2,$3,'net','RECIPIENT','INITIATOR',20000,now()+interval '72 hours')`, [randomUUID(), r, f.root])).rejects.toMatchObject({ code: '23514' });
  } else await expect(obligation(f, r, source, 20000, payer)).rejects.toMatchObject({ code: '23514' });
});
it('accepts settled reversal at the inclusive 60000 ceiling and forbids reuse across resolutions, cases and roots', async () => {
  const f = await caseFixture(); const source = await originalPayment(f.orderId);
  const changes = { compensationComponents: { ...components(20000, 'RECIPIENT'), recipientExtraFen: 20000, recipientShippingFen: 20000 }, netCompensationFen: 60000, compensationPayer: 'RECIPIENT' };
  await obligation(f, await resolution(f, changes), source, 60000);
  await expect(obligation(f, await resolution(f, { ...changes, number: 2 }), source, 60000)).rejects.toMatchObject({ code: '23505' });
  for (const root of [f.root, randomUUID()]) {
    const successor = await caseFixture(f.orderId, root);
    await expect(obligation(successor, await resolution(successor, changes), source, 60000)).rejects.toMatchObject({ code: '23505' });
  }
});
it('permits null original source for pure extra and shipping compensation', async () => {
  const f = await caseFixture();
  const r = await resolution(f, { compensationComponents: { ...components(), initiatorExtraFen: 100, initiatorShippingFen: 100 }, netCompensationFen: 200, compensationPayer: 'INITIATOR' });
  await expect(obligation(f, r, null, 200, 'INITIATOR')).resolves.toEqual(expect.any(String));
});
it('validates reversal component direction independently of an offset net payer', async () => {
  const f = await caseFixture(); const source = await originalPayment(f.orderId);
  const r = await resolution(f, { compensationComponents: { ...components(10000, 'RECIPIENT'), initiatorExtraFen: 20000 }, netCompensationFen: 10000, compensationPayer: 'INITIATOR' });
  await expect(obligation(f, r, source, 10000, 'INITIATOR')).resolves.toEqual(expect.any(String));
});
it('returns a recipient-paid original difference from initiator to recipient', async () => {
  const f = await caseFixture(undefined, randomUUID(), 'RECIPIENT');
  const source = await originalPayment(f.orderId, 'DIFFERENCE', true, 'RECIPIENT');
  const correct = { compensationComponents: components(20000, 'INITIATOR'), netCompensationFen: 20000, compensationPayer: 'INITIATOR' };
  await expect(obligation(f, await resolution(f, correct), source, 20000, 'INITIATOR')).resolves.toEqual(expect.any(String));
  const wrong = await resolution(f, { number: 2, compensationComponents: components(20000, 'RECIPIENT'), netCompensationFen: 20000, compensationPayer: 'RECIPIENT' });
  await expect(obligation(f, wrong, source)).rejects.toMatchObject({ code: '23514' });
});

it.each([['TRANSFER', 'REFUND'], ['REFUND', 'TRANSFER']])('rejects stale REPEATABLE READ %s then %s across two connections', async (first, second) => {
  const f = await caseFixture();
  const r = await resolution(f, { compensationComponents: { ...components(), initiatorExtraFen: 100 }, netCompensationFen: 100, compensationPayer: 'INITIATOR' });
  const ob = await obligation(f, r, null, 100, 'INITIATOR'); const payment = randomUUID();
  await client.query(`INSERT INTO "CompensationPayment" (id,"obligationId","businessNo",provider,"amountFen","updatedAt") VALUES ($1,$2,$3,'simulated',100,now())`, [payment, ob, randomUUID()]);
  const entry = (c: pg.Client, type: string) => c.query(`INSERT INTO "CompensationFinancialEntry" (id,"paymentId","entryType",provider,"externalTransactionId","businessNo","amountFen","occurredAt") VALUES ($1,$2,$3,'simulated',$4,$5,100,now())`, [randomUUID(), payment, type, randomUUID(), randomUUID()]);
  await entry(client, 'COLLECTION');
  const stale = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await stale.connect();
    await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect((await stale.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read');
    await stale.query('SELECT count(*) FROM "CompensationFinancialEntry"');
    await entry(client, first); // autocommit after B has established its snapshot
    await expect(entry(stale, second)).rejects.toMatchObject({ code: '23505', constraint: 'CompensationFinancialEntry_one_terminal' });
  } finally { try { await stale.query('ROLLBACK'); } finally { await stale.end(); } }
  expect((await client.query('SELECT "entryType" FROM "CompensationFinancialEntry" WHERE "paymentId"=$1 ORDER BY "entryType"', [payment])).rows.map(row => row.entryType).sort()).toEqual(['COLLECTION', first].sort());
});
