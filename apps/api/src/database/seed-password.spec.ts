import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const apiRoot = fileURLToPath(new URL('../..', import.meta.url));
const localDatabaseUrl =
  'postgresql://barter:barter_local_password@localhost:5432/barter';

function runSeed(adminSeedPassword: string | undefined) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? localDatabaseUrl,
  };

  if (adminSeedPassword === undefined) {
    delete env.ADMIN_SEED_PASSWORD;
  } else {
    env.ADMIN_SEED_PASSWORD = adminSeedPassword;
  }

  return spawnSync(process.execPath, ['--import', 'tsx', 'prisma/seed.ts'], {
    cwd: apiRoot,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
}

describe('admin seed password configuration', () => {
  it.each([undefined, '   '])(
    'fails closed when ADMIN_SEED_PASSWORD is %s',
    (adminSeedPassword) => {
      const result = runSeed(adminSeedPassword);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('ADMIN_SEED_PASSWORD');
    },
  );
});
