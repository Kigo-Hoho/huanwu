import { applyMigrations, createOwnedDatabase, newNamespace } from './database-fixtures.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function setupDatabaseTemplate(seed: boolean) {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('DATABASE_URL is required for PostgreSQL phase3 tests');
  const namespace = newNamespace();
  const template = await createOwnedDatabase(baseUrl, namespace);
  try {
    await applyMigrations(template.url);
    if (seed) {
      const seedPath = fileURLToPath(new URL('../../../prisma/seed.ts', import.meta.url));
      const result = spawnSync(process.execPath, ['--import', 'tsx', seedPath], {
        env: { ...process.env, DATABASE_URL: template.url }, stdio: 'pipe', windowsHide: true,
      });
      if (result.status !== 0) throw new Error('Phase3 test template seed failed');
    }
  }
  catch (error) { await template.close(); throw error; }
  process.env.PHASE3_NAMESPACE = namespace;
  process.env.PHASE3_TEMPLATE = template.name;
  return async () => { await template.close(); delete process.env.PHASE3_NAMESPACE; delete process.env.PHASE3_TEMPLATE; };
}

export default async function setup() { return setupDatabaseTemplate(false); }
