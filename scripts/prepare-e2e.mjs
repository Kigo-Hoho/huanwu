import { rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error('npm_execpath is required; run this preparation through npm run e2e.');
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be provided by the process or CI environment.`);
  }
  return value;
}

function runNpm(args, environment = process.env) {
  const result = spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} exited with status ${result.status}.`);
  }
}

const adminSeedPassword = requiredEnvironment('ADMIN_SEED_PASSWORD');
const reviewerPassword = requiredEnvironment('E2E_REVIEWER_PASSWORD');
const jwtSecret = requiredEnvironment('JWT_SECRET');
requiredEnvironment('DATABASE_URL');

if (adminSeedPassword !== reviewerPassword) {
  throw new Error(
    'E2E_REVIEWER_PASSWORD must match ADMIN_SEED_PASSWORD for the seeded reviewer.',
  );
}
if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must contain at least 32 characters.');
}

const storageDirectory = resolve(repositoryRoot, '.local', 'e2e-item-images');
const storageRelativePath = relative(repositoryRoot, storageDirectory);
if (
  storageRelativePath.startsWith('..') ||
  storageRelativePath === '' ||
  storageRelativePath.includes(':')
) {
  throw new Error('Refusing to remove an E2E storage directory outside the repository.');
}
await rm(storageDirectory, { recursive: true, force: true });

runNpm(['run', 'db:migrate']);
runNpm(['run', 'db:seed']);
runNpm(['run', 'build:h5', '--workspace', '@barter/miniapp'], {
  ...process.env,
  NODE_ENV: 'production',
  TARO_ENV: 'h5',
  TARO_APP_ENVIRONMENT: 'acceptance',
  TARO_APP_IDENTITY_PROVIDER: 'acceptance',
  TARO_APP_API_BASE_URL: 'http://127.0.0.1:3000',
});
