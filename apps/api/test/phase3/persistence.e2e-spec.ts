import pg from 'pg';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPhase3Database, phase3DatabaseName, validateDatabaseName } from './support/database-fixtures.js';

let database: Awaited<ReturnType<typeof createPhase3Database>>;
let client: pg.Client;
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const proposal = '00000000-0000-4000-8000-000000000003';
const version = '00000000-0000-4000-8000-000000000004';
const order = '00000000-0000-4000-8000-000000000005';
const item = '00000000-0000-4000-8000-000000000006';
const second = '00000000-0000-4000-8000-000000000008';
beforeAll(async () => {
  database = await createPhase3Database(); client = new pg.Client({ connectionString: database.url }); await client.connect();
  await client.query(`
    INSERT INTO "User" (id,"updatedAt") VALUES ('${a}',now()),('${b}',now());
    INSERT INTO "Item" (id,"ownerId",title,description,"referenceValueFen",condition,status,"wantedText","updatedAt") VALUES ('${item}','${a}','item','description',1000,'GOOD','ACTIVE','wanted',now());
    INSERT INTO "Item" (id,"ownerId",title,description,"referenceValueFen",condition,status,"wantedText","updatedAt") VALUES ('${second}','${b}','second','description',1000,'GOOD','ACTIVE','wanted',now());
    INSERT INTO "ItemImage" (id,"itemId",url,"sortOrder") SELECT gen_random_uuid(),i.id,'https://img/'||n,n-1 FROM "Item" i CROSS JOIN generate_series(1,3) n;
    INSERT INTO "Proposal" (id,"initiatorId","recipientId","responderId",status,"expiresAt","reservationExpiresAt","updatedAt") VALUES ('${proposal}','${a}','${b}','${b}','CONFIRMED','2030-01-01','2026-10-05T00:00:00',now());
    INSERT INTO "ProposalVersion" (id,"proposalId",number,"authorId","differenceFen",payer,"deliveryMode","initiatorShippingFen","recipientShippingFen") VALUES ('${version}','${proposal}',1,'${a}',0,'NONE','IN_PERSON',0,0);
    INSERT INTO "ProposalVersionItem" (id,"proposalVersionId","itemId","ownerId",side,"sortOrder","itemVersion",title,description,"referenceValueFen",condition,"wantedText","imageUrls") SELECT gen_random_uuid(),'${version}',id,"ownerId",CASE WHEN id='${item}' THEN 'INITIATOR'::"ProposalSide" ELSE 'RECIPIENT'::"ProposalSide" END,0,1,title,description,"referenceValueFen",condition,"wantedText",ARRAY['https://img/1','https://img/2','https://img/3'] FROM "Item";
    INSERT INTO "Order" (id,"proposalId","proposalVersionId","initiatorId","recipientId",status,"rulesVersion","depositFen","feeFen","detailsHours","paymentHours","fulfillmentHours","inspectionHours","differenceFen",payer,"deliveryMode","initiatorShippingFen","recipientShippingFen",simulation,"updatedAt") VALUES ('${order}','${proposal}','${version}','${a}','${b}','AWAITING_PAYMENT','phase3-test-v1',1000,0,24,24,72,72,0,'NONE','IN_PERSON',0,0,true,now());
    INSERT INTO "OrderItemSnapshot" (id,"orderId","itemId","ownerId",side,"sortOrder","itemVersion",title,description,"referenceValueFen",condition,"wantedText","imageUrls") VALUES ('00000000-0000-4000-8000-000000000007','${order}','${item}','${a}','INITIATOR',0,1,'snapshot','old description',1000,'GOOD','wanted',ARRAY['https://img/1','https://img/2','https://img/3']);
  `);
});
afterAll(async () => { await client?.end(); await database?.close(); });

it('persists all order, funds, logistics, integration and provider models', async () => {
  const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  expect(rows.map(row => row.tablename)).toEqual(expect.arrayContaining(['Order', 'OrderItemSnapshot', 'OrderPartyProgress', 'OrderAddress', 'PaymentIntent', 'FinancialEntry', 'IntegrationEvent', 'IntegrationEventReceipt', 'Shipment', 'ShipmentEvent', 'OrderCancellation', 'OutboxCommand', 'SimulatedProviderOperation']));
});
it('supports nullable proposal ownership and permanent order ownership', async () => {
  const { rows } = await client.query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='ItemReservation'");
  expect(rows).toEqual(expect.arrayContaining([{ column_name: 'orderId', is_nullable: 'YES' }, { column_name: 'expiresAt', is_nullable: 'YES' }]));
});
it('refuses cleanup targets outside the current run', () => {
  expect(() => validateDatabaseName('barter', process.env.PHASE3_NAMESPACE!)).toThrow(/Refusing/);
  expect(() => validateDatabaseName('barter_p3_other_template', process.env.PHASE3_NAMESPACE!)).toThrow(/Refusing/);
});

it('keeps connection credentials out of database comparison failure diagnostics', () => {
  const name = phase3DatabaseName('postgresql://test-user:synthetic-secret@localhost:55432/database_a');
  try { assert.equal(name, 'database_b'); }
  catch (error) {
    expect((error as Error).message).toContain('database_a');
    expect((error as Error).message).not.toContain('synthetic-secret');
    expect((error as Error).message).not.toContain('test-user');
    return;
  }
  throw new Error('Expected mismatched database names to fail');
});

it('clones independent databases and never drops a clone with a live connection', async () => {
  expect(phase3DatabaseName(process.env.DATABASE_URL!)).toBe(phase3DatabaseName(database.url));
  const sibling = await createPhase3Database();
  const connection = new pg.Client({ connectionString: sibling.url });
  await connection.connect();
  try {
    expect(phase3DatabaseName(sibling.url)).not.toBe(phase3DatabaseName(database.url));
    expect((await connection.query('SELECT count(*)::int AS count FROM "Order"')).rows[0].count).toBe(0);
    await expect(sibling.close()).rejects.toThrow(/being accessed by other users/i);
    expect((await connection.query('SELECT current_database() AS name')).rows[0].name).toBe(phase3DatabaseName(sibling.url));
  } finally { await connection.end(); await sibling.close(); }
  expect(phase3DatabaseName(process.env.DATABASE_URL!)).toBe(phase3DatabaseName(database.url));
});

it('rejects two reservation owners and ownerless/incomplete leases at SQL boundary', async () => {
  await expect(client.query(`INSERT INTO "ItemReservation" ("itemId","proposalId","proposalVersionId","orderId","expiresAt") VALUES ('${item}','${proposal}','${version}','${order}','2030-01-01')`)).rejects.toThrow(/check constraint/i);
  await expect(client.query(`INSERT INTO "ItemReservation" ("itemId") VALUES ('${item}')`)).rejects.toThrow(/check constraint/i);
  await expect(client.query(`INSERT INTO "ItemReservation" ("itemId","proposalId","proposalVersionId") VALUES ('${item}','${proposal}','${version}')`)).rejects.toThrow(/check constraint/i);
});

it('enforces different participants, bounded terms and one order per source proposal', async () => {
  const cloneOrder = (values: string) => client.query(`INSERT INTO "Order" SELECT (jsonb_populate_record(NULL::"Order", to_jsonb(o)||jsonb_build_object('id',gen_random_uuid(),${values}))).* FROM "Order" o WHERE id='${order}'`);
  await expect(cloneOrder(`'initiatorId',o."recipientId"`)).rejects.toThrow(/Order_participants_check/);
  await expect(cloneOrder(`'differenceFen',20001,'payer','INITIATOR'`)).rejects.toThrow(/Order_bounds_check/);
  await expect(cloneOrder(`'depositFen',-1`)).rejects.toThrow(/Order_bounds_check/);
  await expect(cloneOrder(`'simulation',true`)).rejects.toThrow(/Order_proposalId_key/);
});

it('allows progress changes while preserving immutable order rules, terms, participants and snapshots', async () => {
  await client.query(`UPDATE "Order" SET version=2,status='AWAITING_FULFILLMENT' WHERE id='${order}'`);
  for (const assignment of ['"depositFen"=2000','"differenceFen"=1','"initiatorId"="recipientId"','"rulesVersion"=\'changed\'','"proposalVersionId"=\'00000000-0000-4000-8000-000000000009\'']) {
    await expect(client.query(`UPDATE "Order" SET ${assignment} WHERE id='${order}'`)).rejects.toThrow(/immutable/i);
  }
  await expect(client.query('UPDATE "OrderItemSnapshot" SET title=\'changed\'')).rejects.toThrow(/immutable/i);
  await expect(client.query('DELETE FROM "OrderItemSnapshot"')).rejects.toThrow(/immutable/i);
  await expect(client.query(`DELETE FROM "Order" WHERE id='${order}'`)).rejects.toThrow(/immutable/i);
});

it('rejects zero/negative payment obligations and duplicate pending cancellations', async () => {
  for (const amount of [0,-1]) await expect(client.query(`INSERT INTO "PaymentIntent" (id,"orderId",side,purpose,"amountFen","businessNo",provider,"updatedAt") VALUES (gen_random_uuid(),'${order}','INITIATOR','DEPOSIT',${amount},'invalid-${amount}','simulated',now())`)).rejects.toThrow(/check constraint/i);
  await client.query(`INSERT INTO "OrderCancellation" (id,"orderId","requestedBySide",reason,"requestedVersion") VALUES (gen_random_uuid(),'${order}','INITIATOR','cancel',2)`);
  await expect(client.query(`INSERT INTO "OrderCancellation" (id,"orderId","requestedBySide",reason,"requestedVersion") VALUES (gen_random_uuid(),'${order}','RECIPIENT','cancel',2)`)).rejects.toThrow(/unique constraint/i);
  await client.query(`UPDATE "OrderCancellation" SET status='REJECTED',"respondedAt"=now() WHERE "orderId"='${order}'`);
  await expect(client.query('DELETE FROM "OrderCancellation"')).rejects.toThrow(/immutable/i);
  await expect(client.query('UPDATE "OrderCancellation" SET reason=\'rewritten\'')).rejects.toThrow(/immutable/i);
});

it('preserves trusted event bodies separately from mutable receipts and financial/shipment history', async () => {
  await client.query(`
    INSERT INTO "PaymentIntent" (id,"orderId",side,purpose,"amountFen","businessNo",provider,"updatedAt") VALUES ('00000000-0000-4000-8000-000000000010','${order}','INITIATOR','DEPOSIT',1000,'deposit-1','simulated',now());
    INSERT INTO "IntegrationEvent" (id,provider,"eventId",kind,"businessNo","occurredAt",payload) VALUES ('00000000-0000-4000-8000-000000000011','simulated','event-1','PAYMENT_SUCCEEDED','deposit-1',now(),'{}');
    INSERT INTO "IntegrationEventReceipt" ("eventId","updatedAt") VALUES ('00000000-0000-4000-8000-000000000011',now());
    INSERT INTO "FinancialEntry" (id,"intentId","integrationEventId","entryType",provider,"externalTransactionId","businessNo","amountFen","occurredAt") VALUES (gen_random_uuid(),'00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000011','PAYMENT','simulated','external-1','paid-1',1000,now());
    INSERT INTO "Shipment" (id,"orderId",side,carrier,"trackingNumber","businessNo","updatedAt") VALUES ('00000000-0000-4000-8000-000000000012','${order}','INITIATOR','SF','TRACK1','ship-1',now());
    INSERT INTO "ShipmentEvent" (id,"shipmentId","integrationEventId",progress,"occurredAt") VALUES (gen_random_uuid(),'00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000011','COLLECTED',now());
  `);
  await client.query('UPDATE "IntegrationEventReceipt" SET status=\'PROCESSED\',"processedAt"=now()');
  for (const table of ['IntegrationEvent','FinancialEntry','ShipmentEvent']) {
    await expect(client.query(`DELETE FROM "${table}"`)).rejects.toThrow(/immutable/i);
    await expect(client.query(`UPDATE "${table}" SET "createdAt"=now()`)).rejects.toThrow(/immutable/i);
  }
  await expect(client.query('UPDATE "PaymentIntent" SET "amountFen"=500')).rejects.toThrow(/immutable/i);
  await expect(client.query(`INSERT INTO "PaymentIntent" SELECT (jsonb_populate_record(NULL::"PaymentIntent",to_jsonb(p)||jsonb_build_object('id',gen_random_uuid(),'businessNo','another-deposit'))).* FROM "PaymentIntent" p`)).rejects.toThrow(/PaymentIntent_orderId_side_purpose_key/);
  await expect(client.query(`INSERT INTO "FinancialEntry" SELECT (jsonb_populate_record(NULL::"FinancialEntry",to_jsonb(f)||jsonb_build_object('id',gen_random_uuid(),'businessNo','paid-2','externalTransactionId','external-2'))).* FROM "FinancialEntry" f`)).rejects.toThrow(/FinancialEntry_intentId_entryType_key/);
  await expect(client.query(`INSERT INTO "IntegrationEvent" SELECT (jsonb_populate_record(NULL::"IntegrationEvent",to_jsonb(e)||jsonb_build_object('id',gen_random_uuid()))).* FROM "IntegrationEvent" e`)).rejects.toThrow(/IntegrationEvent_provider_eventId_key/);
  await expect(client.query(`INSERT INTO "Shipment" SELECT (jsonb_populate_record(NULL::"Shipment",to_jsonb(s)||jsonb_build_object('id',gen_random_uuid(),'side','RECIPIENT','businessNo','ship-2'))).* FROM "Shipment" s`)).rejects.toThrow(/Shipment_carrier_trackingNumber_key/);
});

it('rejects audit rewrites and deletion while keeping append available', async () => {
  await client.query(`INSERT INTO "AuditLog" (id,action,"entityType","entityId") VALUES (gen_random_uuid(),'ORDER_CREATED','Order','${order}')`);
  await expect(client.query('UPDATE "AuditLog" SET action=\'rewritten\'')).rejects.toThrow(/immutable/i);
  await expect(client.query('DELETE FROM "AuditLog"')).rejects.toThrow(/immutable/i);
});

it('hands the exact full lease set to an order in place and never frees it through the old proposal', async () => {
  const { ReservationsService } = await import('../../src/reservations/reservations.service.js');
  const { PrismaService } = await import('../../src/database/prisma.service.js');
  const { PublicItemsService } = await import('../../src/items/public-items.service.js');
  const { ProposalsService } = await import('../../src/proposals/proposals.service.js');
  const { AuditService } = await import('../../src/audit/audit.service.js');
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;
  const prisma = new PrismaService();
  let now = new Date('2026-10-02T00:00:00Z');
  const clock = { now: () => now };
  const reservations = new ReservationsService(clock);
  const proposals = new ProposalsService(prisma, new AuditService(), clock, reservations);
  const publicItems = new PublicItemsService(prisma, clock);
  const offer = { offeredItemIds: [item], targetItemId: second, differenceFen: 0, payer: 'NONE' as const, deliveryMode: 'IN_PERSON' as const, initiatorShippingFen: 0, recipientShippingFen: 0 };
  try {
    const competing = await proposals.create(a, offer, 'competing-before-handoff');
    const expiresAt = new Date('2026-10-05T00:00:00Z');
    await prisma.itemReservation.createMany({ data: [item,second].map(itemId => ({ itemId, proposalId: proposal, proposalVersionId: version, expiresAt })) });
    const original = await prisma.itemReservation.findMany({ orderBy: { itemId: 'asc' } });
    await expect(prisma.$transaction(tx => reservations.assertProposalLease(tx, proposal, version, [item], now))).rejects.toThrow();
    await expect(prisma.$transaction(tx => reservations.assertProposalLease(tx, proposal, version, [item,'00000000-0000-4000-8000-000000000009'], now))).rejects.toThrow();
    await expect(prisma.$transaction(tx => reservations.assertProposalLease(tx, proposal, '00000000-0000-4000-8000-000000000009', [item,second], now))).rejects.toThrow();
    await expect(prisma.$transaction(async tx => {
      await tx.itemReservation.delete({ where: { itemId: second } });
      await reservations.handoffToOrder(tx, proposal, order, [item,second]);
    })).rejects.toThrow();
    await expect(prisma.$transaction(tx => reservations.assertProposalLease(tx, proposal, version, [item,second], expiresAt))).rejects.toThrow();
    await expect(prisma.$transaction(async tx => {
      await tx.itemReservation.update({ where: { itemId: second }, data: { expiresAt: new Date('2026-10-06T00:00:00Z') } });
      await reservations.assertProposalLease(tx, proposal, version, [item,second], now);
    })).rejects.toThrow();
    await expect(prisma.$transaction(async tx => {
      await reservations.lockItems(tx, [second,item]);
      await reservations.handoffToOrder(tx, proposal, order, [item,second]);
      throw new Error('audit unavailable');
    })).rejects.toThrow('audit unavailable');
    expect(await prisma.itemReservation.findMany({ orderBy: { itemId: 'asc' } })).toEqual(original);
    await prisma.$transaction(tx => reservations.handoffToOrder(tx, proposal, order, [second,item]));
    const handed = await prisma.itemReservation.findMany({ orderBy: { itemId: 'asc' } });
    expect(handed).toHaveLength(2);
    for (const [index,row] of handed.entries()) {
      expect(row).toMatchObject({ itemId: original[index]!.itemId, createdAt: original[index]!.createdAt, orderId: order, proposalId: null, proposalVersionId: null, expiresAt: null });
    }
    expect(await prisma.itemReservation.deleteMany({ where: { proposalId: proposal, orderId: null } })).toEqual({ count: 0 });
    await prisma.proposal.update({ where: { id: proposal }, data: { status: 'CONVERTED' } });
    now = new Date('2026-10-06T00:00:00Z');
    expect((await publicItems.get(item)).availableForProposal).toBe(false);
    expect((await publicItems.list()).items.every(row => row.availableForProposal === false)).toBe(true);
    await expect(proposals.create(a, offer, 'new-after-original-expiry')).rejects.toMatchObject({ response: { code: 'ITEM_UNAVAILABLE' } });
    await expect(proposals.command(b, competing.id, 'counter', { ...offer, expectedVersion: 1 }, 'counter-order-occupied')).rejects.toMatchObject({ response: { code: 'ITEM_UNAVAILABLE' } });
    await expect(proposals.command(b, competing.id, 'accept', { expectedVersion: 1 }, 'accept-order-occupied')).rejects.toMatchObject({ response: { code: 'ITEM_UNAVAILABLE' } });
    expect(await proposals.expire(proposal)).toBe(false);
    await expect(proposals.command(a, proposal, 'cancel', { expectedVersion: 1 }, 'cancel-converted')).rejects.toMatchObject({ response: { code: 'PROPOSAL_INVALID_STATE' } });
    expect((await proposals.detail(a, proposal)).orderId).toBe(order);
    expect(await prisma.itemReservation.count({ where: { orderId: order } })).toBe(2);
    await prisma.$transaction(tx => reservations.releaseOrder(tx, order));
    expect(await prisma.itemReservation.count()).toBe(0);
    await Promise.all([
      prisma.$transaction(tx => reservations.lockItems(tx, [second,item])),
      prisma.$transaction(tx => reservations.lockItems(tx, [item,second])),
    ]);
  } finally { await prisma.$disconnect(); if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl; }
});
