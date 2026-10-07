import pg from 'pg';
import { afterAll, expect, it } from 'vitest';
import { applyMigrations, createOwnedDatabase } from './support/database-fixtures.js';

let database: Awaited<ReturnType<typeof createOwnedDatabase>> | undefined;
afterAll(async () => {
  if (!database) return;
  // PostgreSQL DROP DATABASE forces a cluster checkpoint. Await physical
  // disposal in the existing teardown lifecycle, after all business assertions.
  await database.close();
  const inspector = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await inspector.connect();
  try { expect((await inspector.query('SELECT datname FROM pg_database WHERE datname = $1', [database.name])).rows).toHaveLength(0); }
  finally { await inspector.end(); }
});

it('upgrades the original two migrations without changing six leases or immutable history', async () => {
  database = await createOwnedDatabase(process.env.DATABASE_URL!, process.env.PHASE3_NAMESPACE!);
  const client = new pg.Client({ connectionString: database.url });
  try {
    await applyMigrations(database.url, 2);
    await client.connect();
    await client.query(`
      INSERT INTO "User" (id,"updatedAt") VALUES ('00000000-0000-4000-8000-000000000001',now()),('00000000-0000-4000-8000-000000000002',now());
      INSERT INTO "Item" (id,"ownerId",title,description,"referenceValueFen",condition,status,"wantedText","updatedAt")
      SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid, ('00000000-0000-4000-8000-'||CASE WHEN n=15 THEN '000000000002' ELSE '000000000001' END)::uuid, 'old item','historical description',1000,'GOOD','ACTIVE','old wanted',now() FROM generate_series(10,15) n;
      INSERT INTO "Proposal" (id,"initiatorId","recipientId","responderId",status,version,"confirmedAt","expiresAt","reservationExpiresAt","updatedAt") VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','CONFIRMED',2,now(),'2030-01-01','2030-01-01',now());
      INSERT INTO "ProposalVersion" (id,"proposalId",number,"authorId","differenceFen",payer,"deliveryMode","initiatorShippingFen","recipientShippingFen") VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003',1,'00000000-0000-4000-8000-000000000001',0,'NONE','IN_PERSON',0,0);
      INSERT INTO "ProposalVersionItem" (id,"proposalVersionId","itemId","ownerId",side,"sortOrder","itemVersion",title,description,"referenceValueFen",condition,"wantedText","imageUrls") SELECT ('00000000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,'00000000-0000-4000-8000-000000000004',('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('00000000-0000-4000-8000-'||CASE WHEN n=15 THEN '000000000002' ELSE '000000000001' END)::uuid,CASE WHEN n=15 THEN 'RECIPIENT'::"ProposalSide" ELSE 'INITIATOR'::"ProposalSide" END,CASE WHEN n=15 THEN 0 ELSE n-10 END,1,'old title','old description',1000,'GOOD','old wanted',ARRAY['https://img/1','https://img/2','https://img/3'] FROM generate_series(10,15) n;
      INSERT INTO "ItemReservation" ("itemId","proposalId","proposalVersionId","expiresAt") SELECT id,'00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','2030-01-01' FROM "Item";
      INSERT INTO "AuditLog" (id,action,"entityType","entityId") VALUES ('00000000-0000-4000-8000-000000000005','PROPOSAL_CONFIRMED','Proposal','00000000-0000-4000-8000-000000000003');
    `);
    const snapshot = async () => {
      const rows = [];
      for (const table of ['Proposal','ProposalVersion','ProposalVersionItem','AuditLog']) rows.push((await client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows);
      return rows;
    };
    const leases = async () => (await client.query('SELECT "itemId","proposalId","proposalVersionId","expiresAt","createdAt" FROM "ItemReservation" ORDER BY "itemId"')).rows;
    const before = await snapshot(); const originalLeases = await leases();
    expect((await client.query('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name')).rows).toHaveLength(2);
    await applyMigrations(database.url);
    expect((await client.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name')).rows).toEqual([
      { migration_name: '20260922164446_init' }, { migration_name: '20260929083118_proposals' }, { migration_name: '20261002153929_orders' },
    ]);
    expect(await snapshot()).toEqual(before);
    expect(await leases()).toEqual(originalLeases);
    expect(originalLeases).toHaveLength(6);
    await expect(client.query('UPDATE "ProposalVersion" SET "differenceFen"=1')).rejects.toThrow(/immutable/i);
  } finally { await client.end(); }
});
