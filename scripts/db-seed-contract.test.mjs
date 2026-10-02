import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const generatedDirectory = resolve(
  repositoryRoot,
  'apps/api/src/generated/prisma',
);
const generatedClient = resolve(generatedDirectory, 'client.ts');
const backupDirectory = resolve(
  repositoryRoot,
  '.local',
  `db-seed-contract-prisma-${process.pid}`,
);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

test('db:seed generates the ignored Prisma client before seed execution', async () => {
  const hadGeneratedClient = await exists(generatedDirectory);
  await mkdir(resolve(repositoryRoot, '.local'), { recursive: true });
  assert.equal(await exists(backupDirectory), false, 'seed test backup must not pre-exist');
  if (hadGeneratedClient) await rename(generatedDirectory, backupDirectory);

  let commandError;
  try {
    try {
      await execFileAsync(
        process.platform === 'win32'
          ? process.env.ComSpec ?? 'cmd.exe'
          : 'npm',
        process.platform === 'win32'
          ? [
              '/d',
              '/s',
              '/c',
              'npm run db:seed --workspace @barter/api',
            ]
          : ['run', 'db:seed', '--workspace', '@barter/api'],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            ADMIN_SEED_PASSWORD: 'seed-contract-test-only',
            DATABASE_URL:
              'postgresql://barter:unused@127.0.0.1:1/barter?connect_timeout=1',
          },
          timeout: 30_000,
        },
      );
    } catch (error) {
      commandError = error;
    }

    assert.equal(
      await exists(generatedClient),
      true,
      `db:seed did not generate Prisma client before execution.\n${commandError?.stderr ?? ''}`,
    );
  } finally {
    await rm(generatedDirectory, { force: true, recursive: true });
    if (hadGeneratedClient) await rename(backupDirectory, generatedDirectory);
  }
});
