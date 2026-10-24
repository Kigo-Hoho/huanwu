import pg from 'pg';
import { afterAll, expect, it } from 'vitest';
import { createPhase4Database, phase3DatabaseName } from '../phase3/support/database-fixtures.js';

const source = process.env.DATABASE_URL!;
const owned: Awaited<ReturnType<typeof createPhase4Database>>[] = [];
afterAll(async () => {
  for (const database of [...owned].reverse()) await database.close();
  expect(process.env.DATABASE_URL === source).toBe(true);
  const inspector = new pg.Client({ connectionString: source });
  try {
    await inspector.connect();
    for (const database of owned) expect((await inspector.query('SELECT datname FROM pg_database WHERE datname=$1', [phase3DatabaseName(database.url)])).rows).toHaveLength(0);
  } finally { await inspector.end(); }
});
it('keeps owned Phase4 clones independent and refuses to drop a live connection', async () => {
  const first = await createPhase4Database(); owned.push(first);
  const second = await createPhase4Database(); owned.push(second);
  const a = new pg.Client({ connectionString: first.url }); const b = new pg.Client({ connectionString: second.url });
  try {
    await a.connect(); await b.connect();
    expect(phase3DatabaseName(first.url)).not.toBe(phase3DatabaseName(second.url));
    await a.query('INSERT INTO "User" (id,"updatedAt") VALUES (gen_random_uuid(),now())');
    expect((await b.query('SELECT count(*)::int AS count FROM "User"')).rows[0].count).toBe(0);
    await expect(second.close()).rejects.toThrow(/being accessed by other users/i);
    expect((await b.query('SELECT current_database() AS name')).rows[0].name).toBe(phase3DatabaseName(second.url));
  } finally { await a.end(); await b.end(); }
});
