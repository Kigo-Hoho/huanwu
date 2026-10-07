import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { applyMigrations, createOwnedDatabase, newNamespace } from './support/database-fixtures.js';

describe('legacy database unit isolation', () => {
  it.each([2, 3])('preserves a source with %i applied migrations and disposes owned clones', async (migrationCount) => {
    const source = await createOwnedDatabase(process.env.DATABASE_URL!, newNamespace());
    const client = new pg.Client({ connectionString: source.url });
    try {
      await applyMigrations(source.url, migrationCount);
      await client.connect();
      const snapshot = async () => ({
        migrations: (await client.query('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name')).rows,
        counts: (await client.query('SELECT (SELECT count(*) FROM "AuditLog") AS audits, (SELECT count(*) FROM "User") AS users, (SELECT count(*) FROM "Item") AS items')).rows,
      });
      const before = await snapshot();
      const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: source.url };
      delete env.PHASE3_NAMESPACE;
      delete env.PHASE3_TEMPLATE;
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', 'src/audit/audit.service.spec.ts', 'src/items/item-review.service.spec.ts'], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), env, encoding: 'utf8', windowsHide: true, timeout: 120000,
      });
      // Never expose child output, which can contain inherited credentials.
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('4 passed');
      expect(await snapshot()).toEqual(before);
    } finally {
      await client.end();
      await source.close();
    }
  }, 150000);
});
