import pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as orders from '../phase3/support/order-harness.js';
import { phase3DatabaseName } from '../phase3/support/database-fixtures.js';
import { createAfterSalesHarness } from './support/after-sales-harness.js';

const source = process.env.DATABASE_URL!;
const previous = new Map(['NODE_ENV', 'PAYMENT_PROVIDER', 'LOGISTICS_PROVIDER'].map(key => [key, process.env[key]]));
let ownedName: string | undefined;
let initialization: ReturnType<typeof createAfterSalesHarness>;
beforeAll(async () => {
  const create = orders.createOrderHarness;
  // Keep real Nest/Prisma/owned database lifecycle; fail only the added fixture
  // insert after the base harness has established its connected resources.
  vi.spyOn(orders, 'createOrderHarness').mockImplementationOnce(async () => {
    const base = await create();
    ownedName = phase3DatabaseName(process.env.DATABASE_URL!);
    vi.spyOn(base.prisma.user, 'create').mockRejectedValueOnce(new Error('Injected additional actor creation failure'));
    return base;
  });
  initialization = createAfterSalesHarness();
  await initialization.catch(() => undefined);
});
afterAll(async () => {
  const unexpected = await initialization?.catch(() => undefined);
  try { await unexpected?.close(); } finally { vi.restoreAllMocks(); }
});
it('disposes its connected database and restores provider environment when an added actor insert fails', async () => {
  await expect(initialization).rejects.toThrow('Injected additional actor creation failure');
  expect(ownedName).toBeDefined();
  expect(process.env.DATABASE_URL === source).toBe(true);
  for (const [key, value] of previous) expect(process.env[key]).toBe(value);
  const inspector = new pg.Client({ connectionString: source });
  try {
    await inspector.connect();
    expect((await inspector.query('SELECT datname FROM pg_database WHERE datname=$1', [ownedName])).rows).toHaveLength(0);
  } finally { await inspector.end(); }
});
