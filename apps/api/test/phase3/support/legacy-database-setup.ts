import { afterAll, expect, vi } from 'vitest';
import { createPhase3Database } from './database-fixtures.js';
import { OutboxWorker } from '../../../src/integrations/outbox.worker.js';

// setupFiles run before imports, including files constructing Prisma at module scope.
if (expect.getState().testPath?.endsWith('.e2e-spec.ts')) {
  // Legacy tests own isolated file databases and do not exercise background dispatch.
  const workerLifecycle = vi.spyOn(OutboxWorker.prototype, 'onModuleInit').mockImplementation(() => {});
  const originalUrl = process.env.DATABASE_URL;
  const database = await createPhase3Database();
  process.env.DATABASE_URL = database.url;
  afterAll(async () => {
    workerLifecycle.mockRestore();
    try { await database.close(); }
    finally { if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl; }
  });
}
