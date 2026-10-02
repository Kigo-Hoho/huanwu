import { afterAll, expect } from 'vitest';
import { createPhase3Database } from './database-fixtures.js';

// setupFiles run before imports, including files constructing Prisma at module scope.
if (expect.getState().testPath?.endsWith('.e2e-spec.ts')) {
  const originalUrl = process.env.DATABASE_URL;
  const database = await createPhase3Database();
  process.env.DATABASE_URL = database.url;
  afterAll(async () => {
    try { await database.close(); }
    finally { if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl; }
  });
}
