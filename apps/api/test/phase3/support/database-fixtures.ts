import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrations = fileURLToPath(new URL('../../../prisma/migrations/', import.meta.url));

async function removeMigrationDirectory(directory: string, originalError?: unknown): Promise<void> {
  try {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.split(sep).at(-1)?.startsWith('barter-p3-migrations-')) throw new Error('Refusing unsafe migration fixture cleanup');
    await rm(directory, { recursive: true });
  } catch (cleanupError) {
    if (originalError !== undefined) throw new AggregateError([originalError, cleanupError], 'Migration and fixture cleanup both failed', { cause: cleanupError });
    throw cleanupError;
  }
}

export function newNamespace(): string { return `barter_p3_${randomBytes(8).toString('hex')}_`; }

// Compare this projection, never connection URLs, in assertions/failure diagnostics.
export function phase3DatabaseName(url: string): string { return new URL(url).pathname.slice(1); }

export function validateDatabaseName(name: string, namespace: string): void {
  if (!/^barter_p3_[a-f0-9]{16}_$/.test(namespace) || !name.startsWith(namespace) ||
      !/^[a-z0-9_]+$/.test(name) || name.length >= 63 || name.length <= namespace.length) {
    throw new Error('Refusing database outside this phase3 run namespace');
  }
}

export async function createOwnedDatabase(baseUrl: string, namespace: string, template?: string) {
  const name = `${namespace}${randomBytes(6).toString('hex')}`;
  validateDatabaseName(name, namespace);
  if (template) validateDatabaseName(template, namespace);
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ''}`);
    created = true;
  } finally { await admin.end(); }
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  let closed = false;
  return {
    name, url: url.toString(),
    async close(): Promise<void> {
      if (closed || !created) return;
      validateDatabaseName(name, namespace);
      if (phase3DatabaseName(baseUrl) === name) throw new Error('Refusing to drop source database');
      const cleanup = new pg.Client({ connectionString: adminUrl.toString() });
      await cleanup.connect();
      try { await cleanup.query(`DROP DATABASE "${name}"`); closed = true; }
      finally { await cleanup.end(); }
    },
  };
}

export async function applyMigrations(url: string, count?: number): Promise<void> {
  const name = phase3DatabaseName(url);
  const namespace = name.match(/^(barter_p3_[a-f0-9]{16}_)/)?.[1];
  if (!namespace) throw new Error('Refusing migration outside an owned phase3 database');
  validateDatabaseName(name, namespace);
  const directory = await mkdtemp(join(tmpdir(), 'barter-p3-migrations-'));
  let originalError: unknown;
  try {
    let migrationPath = migrations;
    if (count !== undefined) {
      migrationPath = join(directory, 'migrations');
      const names = (await readdir(migrations)).filter(name => /^\d+_/.test(name)).sort();
      for (const name of names.slice(0, count)) await cp(join(migrations, name), join(migrationPath, name), { recursive: true });
      await cp(join(migrations, 'migration_lock.toml'), join(migrationPath, 'migration_lock.toml'));
    }
    const config = join(directory, 'prisma.config.mjs');
    const schema = fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url));
    await writeFile(config, `export default { schema: ${JSON.stringify(schema)}, migrations: { path: ${JSON.stringify(migrationPath)} }, datasource: { url: process.env.DATABASE_URL } };`, { flag: 'wx' });
    const cli = fileURLToPath(new URL('../../../../../node_modules/prisma/build/index.js', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy', '--config', config], {
      env: { ...process.env, DATABASE_URL: url }, windowsHide: true, encoding: 'utf8', timeout: 60000,
    });
    if (result.status !== 0) throw new Error(`Prisma migrate deploy failed: ${result.stderr?.replaceAll(url, '[database URL redacted]')}`);
  } catch (error) { originalError = error; throw error; }
  finally { await removeMigrationDirectory(directory, originalError); }
}

export async function createPhase3Database(): Promise<{ url: string; close(): Promise<void> }> {
  const { PHASE3_NAMESPACE: namespace, PHASE3_TEMPLATE: template, DATABASE_URL: baseUrl } = process.env;
  if (!namespace || !template || !baseUrl) throw new Error('Phase3 global database setup is required');
  const database = await createOwnedDatabase(baseUrl, namespace, template);
  process.env.DATABASE_URL = database.url;
  return {
    url: database.url,
    async close() {
      try { await database.close(); }
      finally { process.env.DATABASE_URL = baseUrl; }
    },
  };
}
