import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { applyMigrations, createOwnedDatabase, newNamespace, phase3DatabaseName, validateDatabaseName } from '../apps/api/test/phase3/support/database-fixtures.ts';

const root = resolve(import.meta.dirname, '..');
const privateNames = ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_SEED_PASSWORD', 'E2E_REVIEWER_PASSWORD', 'ADDRESS_ENCRYPTION_KEY_BASE64', 'ADDRESS_ENCRYPTION_KEY_VERSION', 'SIMULATED_INTEGRATION_SIGNING_KEY_BASE64', 'PAYMENT_PROVIDER', 'LOGISTICS_PROVIDER', 'BARTER_E2E_API_ENV'];

export function acceptanceEnvironment(source, databaseUrl, storageDirectory) {
  try {
    const name = phase3DatabaseName(databaseUrl);
    validateDatabaseName(name, name.match(/^(barter_p3_[a-f0-9]{16}_)/)?.[1] ?? '');
    if (phase3DatabaseName(source.DATABASE_URL) === name) throw new Error();
  } catch { throw new Error('Acceptance requires a distinct owned database'); }
  const frontend = { ...source };
  for (const key of privateNames) delete frontend[key];
  const api = {
    ...source, DATABASE_URL: databaseUrl, NODE_ENV: 'test', PORT: '3000',
    WECHAT_IDENTITY_PROVIDER: 'acceptance',
    PAYMENT_PROVIDER: 'simulated', LOGISTICS_PROVIDER: 'simulated',
    ADDRESS_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    ADDRESS_ENCRYPTION_KEY_VERSION: 'acceptance-v1',
    SIMULATED_INTEGRATION_SIGNING_KEY_BASE64: randomBytes(32).toString('base64'),
    LOCAL_IMAGE_STORAGE_DIR: storageDirectory,
  };
  return { api, frontend, browser: { ...frontend, E2E_REVIEWER_PASSWORD: source.E2E_REVIEWER_PASSWORD, BARTER_E2E_API_ENV: JSON.stringify(api), BARTER_E2E_DATABASE_NAME: phase3DatabaseName(databaseUrl), BARTER_E2E_SOURCE_DATABASE_NAME: phase3DatabaseName(source.DATABASE_URL) } };
}

export async function withOwnedDatabase(database, run, proof) {
  let failure;
  try { await run(); } catch (error) { failure = error; }
  const cleanupErrors = [];
  try { await database.close(); } catch (error) { cleanupErrors.push(error); }
  try { await proof(); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], cleanupErrors.map(error => error.message).join('; '));
  if (failure) throw failure;
}

async function sourceSnapshot(url) {
  const client = new pg.Client({ connectionString: url }); await client.connect();
  try {
    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const counts = [];
    for (const { tablename } of tables) {
      const identifier = tablename.replaceAll('"', '""');
      counts.push([tablename, (await client.query(`SELECT COUNT(*)::text AS count FROM "${identifier}"`)).rows[0].count]);
    }
    const migrations = tables.some(row => row.tablename === '_prisma_migrations')
      ? (await client.query('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name')).rows : [];
    return { counts, migrations };
  } finally { await client.end(); }
}

async function catalogProof(source, namespace) {
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const client = new pg.Client({ connectionString: adminUrl.toString() }); await client.connect();
  try { assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM pg_database WHERE starts_with(datname,$1)', [namespace])).rows[0].count, 0, 'Owned database must be absent from catalog'); }
  finally { await client.end(); }
}

function command(args, environment) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: environment, windowsHide: true, stdio: 'inherit' });
    child.once('error', () => reject(new Error('Acceptance subprocess could not start')));
    child.once('close', code => code === 0 ? done() : reject(new Error(`Acceptance subprocess exited ${code}`)));
  });
}

async function main(args) {
  for (const name of ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_SEED_PASSWORD', 'E2E_REVIEWER_PASSWORD', 'npm_execpath']) {
    if (!process.env[name]?.trim()) throw new Error(`${name} is required in the process environment`);
  }
  if (process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  if (process.env.ADMIN_SEED_PASSWORD !== process.env.E2E_REVIEWER_PASSWORD) throw new Error('Seed and reviewer passwords must match');
  const source = process.env.DATABASE_URL;
  const before = await sourceSnapshot(source);
  const namespace = newNamespace();
  const database = await createOwnedDatabase(source, namespace);
  await withOwnedDatabase(database, async () => {
    const images = await mkdtemp(join(tmpdir(), 'barter-e2e-images-'));
    try {
      await applyMigrations(database.url);
      const env = acceptanceEnvironment(process.env, database.url, images);
      const npm = process.env.npm_execpath;
      await command([npm, 'run', 'db:seed'], env.api);
      await command([npm, 'run', 'build', '--workspace', '@barter/api'], env.api);
      await command([npm, 'run', 'build:h5', '--workspace', '@barter/miniapp'], {
        ...env.frontend, NODE_ENV: 'production', TARO_ENV: 'h5', TARO_APP_ENVIRONMENT: 'acceptance',
        TARO_APP_IDENTITY_PROVIDER: 'acceptance', TARO_APP_API_BASE_URL: 'http://127.0.0.1:3000',
        TARO_APP_INTEGRATION_MODE: 'simulated',
      });
      await command([resolve(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'e2e/playwright.config.ts', ...args], env.browser);
    } finally { await rm(images, { recursive: true }); }
  }, async () => {
    await catalogProof(source, namespace);
    assert.deepEqual(await sourceSnapshot(source), before, 'Source public table counts and migrations must remain unchanged');
    console.log(`E2E isolation verified: owned database dropped; source ${before.migrations.length} migrations and ${before.counts.length} public table counts unchanged.`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Driver errors may include credentials or invalid URL input; never print them.
  await main(process.argv.slice(2)).catch(() => { console.error('E2E failed; inspect preceding checks. Cleanup failures remain fatal; no database is forcibly dropped.'); process.exitCode = 1; });
}
