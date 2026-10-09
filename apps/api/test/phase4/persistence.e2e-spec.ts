import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAfterSalesHarness, type AfterSalesHarness } from './support/after-sales-harness.js';
import { applyMigrations, createOwnedDatabase } from '../phase3/support/database-fixtures.js';
import { OutboxWorker } from '../../src/integrations/outbox.worker.js';
import { OutboxHandlerRegistry } from '../../src/integrations/outbox-handler.registry.js';

let h: AfterSalesHarness;
let client: pg.Client;
let orderId: string;
const caseId = randomUUID(); const rootDisputeId = randomUUID(); const resolutionId = randomUUID();
beforeAll(async () => {
  h = await createAfterSalesHarness();
  client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
  orderId = (await h.prepareOrder({ mode: 'IN_PERSON', differenceFen: 20000, payer: 'INITIATOR' })).id;
});
afterAll(async () => { try { await client?.end(); } finally { await h?.close(); } });
it('persists every case, return, compensation, risk and operator security boundary', async () => {
  const names = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(r => r.tablename);
  expect(names).toEqual(expect.arrayContaining(['AfterSalesCase', 'CaseRecord', 'CaseEvidence', 'ResolutionVersion', 'ResolutionConsent', 'ResolutionApproval', 'ResolutionExecution', 'ReturnObligation', 'ReturnShipment', 'ReturnEvent', 'CompensationObligation', 'CompensationPayment', 'CompensationFinancialEntry', 'RiskReport', 'RiskRecord', 'TradingRestriction', 'RiskTask', 'OperatorSession', 'OperatorDevice', 'ActionGrant', 'OrderHoldBlocker', 'OrderDeadlineExtension', 'ReturnAddress']));
});
it('allows at most one open case and permits a successor after closure', async () => {
  await client.query('INSERT INTO "AfterSalesCase" (id,"orderId","rootDisputeId","applicantId",reason,"updatedAt") VALUES ($1,$2,$3,$4,$5,now())', [caseId, orderId, rootDisputeId, h.actors.initiator.id, '物品存在争议']);
  const next = () => client.query('INSERT INTO "AfterSalesCase" (id,"orderId","rootDisputeId","applicantId",reason,"updatedAt") VALUES ($1,$2,$3,$4,$5,now())', [randomUUID(), orderId, rootDisputeId, h.actors.recipient.id, '另一方补充诉求']);
  await expect(next()).rejects.toThrow(/AfterSalesCase_one_open/);
  await client.query('UPDATE "AfterSalesCase" SET status=\'RESOLVED\',"closedAt"=now() WHERE id=$1', [caseId]);
  await next();
});
it('rejects rewrites and deletes of resolution, consent, approval, records and private evidence', async () => {
  await client.query('INSERT INTO "ResolutionVersion" (id,"caseId",number,"authorId",type,reason,"rulesVersion","itemSnapshotIds",responsibility,"originalFunds","returnPlan","compensationComponents","netCompensationFen","compensationPayer","orderOutcome") VALUES ($1,$2,1,$3,\'FUNDS_ONLY\',\'核验原款\',\'phase4-simulation-v1\',$4,\'INITIATOR\',\'[]\',\'[]\',\'{"originalDifferenceReversal":{"amountFen":0,"payer":"NONE"},"initiatorExtraFen":20000,"recipientExtraFen":0,"initiatorShippingFen":20000,"recipientShippingFen":0}\',40000,\'INITIATOR\',\'PRESERVE_TERMINAL\')', [resolutionId, caseId, h.actors.operations.id, (await h.prisma.orderItemSnapshot.findMany({ where: { orderId } })).map(i => i.id)]);
  await client.query('INSERT INTO "ResolutionConsent" (id,"resolutionId","actorId",side,decision) VALUES ($1,$2,$3,\'INITIATOR\',\'AGREE\')', [randomUUID(), resolutionId, h.actors.initiator.id]);
  await client.query('INSERT INTO "ResolutionApproval" (id,"resolutionId","actorId","sessionId","grantId") VALUES ($1,$2,$3,$4,$5)', [randomUUID(), resolutionId, h.actors.superAdminOne.id, ...await securityReferences()]);
  await client.query('INSERT INTO "CaseRecord" (id,"caseId","actorId",kind,description) VALUES ($1,$2,$3,\'NOTE\',\'补充处理记录\')', [randomUUID(), caseId, h.actors.operations.id]);
  await client.query('INSERT INTO "CaseEvidence" (id,"caseId","uploaderId",description,"originalKey","displayKey",sha256,bytes,"mimeType",width,height) VALUES ($1,$2,$3,\'包装照片\',\'private/original\',\'private/display\',$4,100,\'image/png\',10,10)', [randomUUID(), caseId, h.actors.initiator.id, 'a'.repeat(64)]);
  for (const table of ['ResolutionVersion', 'ResolutionConsent', 'ResolutionApproval', 'CaseRecord', 'CaseEvidence']) {
    await expect(client.query(`UPDATE "${table}" SET "createdAt"=now()`)).rejects.toThrow(/immutable/i);
    await expect(client.query(`DELETE FROM "${table}"`)).rejects.toThrow(/immutable/i);
  }
});
async function securityReferences(): Promise<[string, string]> {
  const device = randomUUID(); const session = randomUUID(); const grant = randomUUID();
  await client.query('INSERT INTO "OperatorDevice" (id,"actorId","credentialDigest",capability,status,"updatedAt") VALUES ($1,$2,$3,\'DESKTOP_PRIVILEGED\',\'APPROVED\',now())', [device, h.actors.superAdminOne.id, 'a'.repeat(64)]);
  await client.query('INSERT INTO "OperatorSession" (id,"actorId","deviceId",capability,"expiresAt") VALUES ($1,$2,$3,\'DESKTOP_PRIVILEGED\',now()+interval \'30 minutes\')', [session, h.actors.superAdminOne.id, device]);
  await client.query('INSERT INTO "ActionGrant" (id,"actorId","sessionId","deviceId",action,"resourceId","expectedVersion","requestDigest","expiresAt") VALUES ($1,$2,$3,$4,\'APPROVE_FUNDS\',$5,1,$6,now()+interval \'5 minutes\')', [grant, h.actors.superAdminOne.id, session, device, caseId, 'a'.repeat(64)]);
  return [session, grant];
}
it('rejects over-limit components, inconsistent net amounts and undefined original funds destinations', async () => {
  const clone = (changes: object) => client.query('INSERT INTO "ResolutionVersion" SELECT (jsonb_populate_record(NULL::"ResolutionVersion",to_jsonb(r)||$2::jsonb)).* FROM "ResolutionVersion" r WHERE id=$1', [resolutionId, JSON.stringify({ id: randomUUID(), number: 2, ...changes })]);
  await expect(clone({ compensationComponents: { originalDifferenceReversal: { amountFen: 0, payer: 'NONE' }, initiatorExtraFen: 20001, recipientExtraFen: 0, initiatorShippingFen: 0, recipientShippingFen: 0 }, netCompensationFen: 20001, compensationPayer: 'INITIATOR' })).rejects.toThrow(/component|bounds/i);
  await expect(clone({ netCompensationFen: 1, compensationPayer: 'INITIATOR' })).rejects.toThrow(/net compensation/i);
  await expect(clone({ originalFunds: [{ paymentIntentId: randomUUID(), destination: 'DECIDE_LATER' }] })).rejects.toThrow(/funds destination/i);
});
it('bounds compensation obligations, origins and mutually exclusive terminal dispositions', async () => {
  const obligation = randomUUID(); const payment = randomUUID();
  const insert = (amount: number, step: string, payer = 'INITIATOR', payee = 'RECIPIENT') => client.query('INSERT INTO "CompensationObligation" (id,"resolutionId","rootDisputeId","executionStep","payerSide","payeeSide","amountFen","paymentDeadline") VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval \'72 hours\')', [randomUUID(), resolutionId, rootDisputeId, step, payer, payee, amount]);
  for (const amount of [0, -1, 60001]) await expect(insert(amount, `invalid-${amount}`)).rejects.toThrow(/check constraint/i);
  await expect(insert(39999, 'wrong-source-amount')).rejects.toThrow(/resolution amount/i);
  await expect(insert(100, 'invalid-direction', 'INITIATOR', 'INITIATOR')).rejects.toThrow(/check constraint/i);
  await client.query('INSERT INTO "CompensationObligation" (id,"resolutionId","rootDisputeId","executionStep","payerSide","payeeSide","amountFen","paymentDeadline") VALUES ($1,$2,$3,\'net\',\'INITIATOR\',\'RECIPIENT\',40000,now()+interval \'72 hours\')', [obligation, resolutionId, rootDisputeId]);
  await expect(insert(40000, 'net')).rejects.toThrow(/unique constraint/i);
  await expect(insert(40000, 'second-net-step')).rejects.toThrow(/CompensationObligation_one_net/);
  await client.query('INSERT INTO "CompensationPayment" (id,"obligationId","businessNo",provider,"amountFen","updatedAt") VALUES ($1,$2,$3,\'simulated\',40000,now())', [payment, obligation, `compensation:${payment}`]);
  const entry = (type: string, amount = 40000) => client.query('INSERT INTO "CompensationFinancialEntry" (id,"paymentId","entryType",provider,"externalTransactionId","businessNo","amountFen","occurredAt") VALUES ($1,$2,$3,\'simulated\',$4,$5,$6,now())', [randomUUID(), payment, type, randomUUID(), randomUUID(), amount]);
  await expect(entry('TRANSFER')).rejects.toThrow(/confirmed collection/i);
  await entry('COLLECTION');
  await expect(entry('TRANSFER', 60001)).rejects.toThrow(/amount|conservation/i);
  await entry('TRANSFER');
  await expect(entry('REFUND')).rejects.toThrow(/terminal disposition/i);
  for (const table of ['CompensationObligation', 'CompensationFinancialEntry']) {
    await expect(client.query(`UPDATE "${table}" SET "createdAt"=now()`)).rejects.toThrow(/immutable/i);
    await expect(client.query(`DELETE FROM "${table}"`)).rejects.toThrow(/immutable/i);
  }
  await expect(client.query('UPDATE "CompensationPayment" SET "amountFen"=1')).rejects.toThrow(/immutable/i);
});
it('backfills only a trustworthy completedAt audit and leaves unsupported history unknown', async () => {
  const database = await createOwnedDatabase(process.env.DATABASE_URL!, process.env.PHASE4_NAMESPACE!);
  const old = new pg.Client({ connectionString: database.url });
  try {
    await applyMigrations(database.url, 3); await old.connect();
    const a = randomUUID(); const b = randomUUID();
    await old.query('INSERT INTO "User" (id,"updatedAt") VALUES ($1,now()),($2,now())', [a, b]);
    const orders: string[] = [];
    for (let i = 0; i < 5; i++) {
      const proposal = randomUUID(); const version = randomUUID(); const order = randomUUID(); orders.push(order);
      await old.query('INSERT INTO "Proposal" (id,"initiatorId","recipientId","responderId",status,"expiresAt","updatedAt") VALUES ($1,$2,$3,$3,\'CONVERTED\',now(),now())', [proposal, a, b]);
      await old.query('INSERT INTO "ProposalVersion" (id,"proposalId",number,"authorId","differenceFen",payer,"deliveryMode","initiatorShippingFen","recipientShippingFen") VALUES ($1,$2,1,$3,0,\'NONE\',\'IN_PERSON\',0,0)', [version, proposal, a]);
      await old.query('INSERT INTO "Order" (id,"proposalId","proposalVersionId","initiatorId","recipientId",status,"rulesVersion","depositFen","feeFen","detailsHours","paymentHours","fulfillmentHours","inspectionHours","differenceFen",payer,"deliveryMode","initiatorShippingFen","recipientShippingFen",simulation,"updatedAt") VALUES ($1,$2,$3,$4,$5,\'COMPLETED\',\'phase3-v1\',1000,0,24,24,72,72,0,\'NONE\',\'IN_PERSON\',0,0,true,\'2030-01-01\')', [order, proposal, version, a, b]);
      if (i !== 1) await old.query('INSERT INTO "AuditLog" (id,action,"entityType","entityId",after) VALUES ($1,$2,\'Order\',$3,$4)', [randomUUID(), i === 3 ? 'OTHER_ACTION' : 'ORDER_COMPLETED', order, JSON.stringify({ status: 'COMPLETED', completedAt: i === 2 ? '2026-99-99T00:00:00.000Z' : '2026-10-03T12:34:56.789Z' })]);
      if (i === 4) await old.query('INSERT INTO "AuditLog" (id,action,"entityType","entityId",after) VALUES ($1,\'ORDER_COMPLETED\',\'Order\',$2,$3)', [randomUUID(), order, JSON.stringify({ status: 'COMPLETED', completedAt: '2026-10-04T00:00:00.000Z' })]);
    }
    const audits = (await old.query('SELECT * FROM "AuditLog" ORDER BY id')).rows;
    await applyMigrations(database.url);
    // Existing Prisma DateTime columns store UTC without a zone; tell pg which
    // zone to use rather than allowing the Windows process timezone to infer it.
    const result = (await old.query('SELECT id,status,"updatedAt" AT TIME ZONE \'UTC\' AS "updatedAt","completedAt" AT TIME ZONE \'UTC\' AS "completedAt" FROM "Order"')).rows;
    expect(result.find(r => r.id === orders[0]).completedAt.toISOString()).toBe('2026-10-03T12:34:56.789Z');
    for (const id of orders.slice(1)) expect(result.find(r => r.id === id).completedAt).toBeNull();
    expect(result.every(r => r.status === 'COMPLETED' && r.updatedAt.toISOString() === '2030-01-01T00:00:00.000Z')).toBe(true);
    expect((await old.query('SELECT * FROM "AuditLog" ORDER BY id')).rows).toEqual(audits);
    expect((await old.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).rows).toHaveLength(4);
  } finally { try { await old.end(); } finally { await database.close(); } }
});
it('persists the normal settlement timestamp together with its completed audit', async () => {
  const order = await h.prepareOrder({ mode: 'IN_PERSON' });
  const current = () => h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const worker = new OutboxWorker(h.prisma, h.clock, h.app.get(OutboxHandlerRegistry));
  for (const side of ['initiator', 'recipient'] as const) {
    const started = await h.command(h.actors[side], `/api/orders/${order.id}/payments`, { expectedVersion: (await current()).version, purpose: 'DEPOSIT' }).expect(202);
    await worker.tick();
    await h.command(h.actors[side], `/api/testing/payments/${started.body.paymentIntentId}/complete`, { expectedVersion: (await current()).version }).expect(200);
  }
  for (const side of ['initiator', 'recipient'] as const) await h.command(h.actors[side], `/api/orders/${order.id}/handover`, { expectedVersion: (await current()).version }).expect(200);
  for (const side of ['initiator', 'recipient'] as const) await h.command(h.actors[side], `/api/orders/${order.id}/acceptance`, { expectedVersion: (await current()).version }).expect(200);
  await worker.tick(); await worker.tick();
  const completed = await current();
  expect(completed.status).toBe('COMPLETED');
  expect((completed as unknown as { completedAt: Date | null }).completedAt?.toISOString()).toBe('2026-10-09T00:00:00.000Z');
  expect((await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'ORDER_COMPLETED', entityId: order.id } })).after).toMatchObject({ completedAt: '2026-10-09T00:00:00.000Z' });
});
