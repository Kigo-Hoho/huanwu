import pg from 'pg';
import { afterAll, expect, it, vi } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { createOrderHarness } from './support/order-harness.js';
import * as databases from './support/database-fixtures.js';

let allocated: Awaited<ReturnType<typeof databases.createPhase3Database>> | undefined;
const source = process.env.DATABASE_URL!;
afterAll(async () => { vi.restoreAllMocks(); await allocated?.close(); });

it('drops the real owned clone and restores the source environment after connected application initialization fails', async () => {
  const create = databases.createPhase3Database;
  vi.spyOn(databases, 'createPhase3Database').mockImplementationOnce(async () => { allocated = await create(); return allocated; });
  const initialize = PrismaService.prototype.onModuleInit;
  vi.spyOn(PrismaService.prototype, 'onModuleInit').mockImplementationOnce(async function (this: PrismaService) {
    await initialize.call(this); throw Error('injected connected initialization failure');
  });
  await expect(createOrderHarness()).rejects.toThrow('injected connected initialization failure');
  expect(process.env.DATABASE_URL === source).toBe(true);
  expect(allocated).toBeDefined();
  const inspector = new pg.Client({ connectionString: source });
  try {
    await inspector.connect();
    const name = databases.phase3DatabaseName(allocated!.url);
    expect((await inspector.query('SELECT datname FROM pg_database WHERE datname = $1', [name])).rows).toHaveLength(0);
    console.log('Connected initialization failure: owned database absent; source environment restored.');
  } finally { await inspector.end(); }
});
