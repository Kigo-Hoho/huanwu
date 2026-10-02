import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

test('root manifest declares every product workspace', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.deepEqual(manifest.workspaces, ['apps/*', 'packages/*']);
  assert.equal(manifest.engines.node, '>=24.15.0');
  assert.ok(manifest.scripts.verify);
});

test('root quality gates run before product workspaces are added', async () => {
  for (const script of ['lint', 'typecheck', 'build']) {
    await execFileAsync(
      isWindows ? process.env.ComSpec ?? 'cmd.exe' : 'npm',
      isWindows ? ['/d', '/s', '/c', `npm run ${script}`] : ['run', script],
      {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
      },
    );
  }
});

test('root typecheck succeeds before contracts have been built', async () => {
  await rm(new URL('../packages/contracts/dist/', import.meta.url), {
    force: true,
    recursive: true,
  });

  await execFileAsync(
    isWindows ? process.env.ComSpec ?? 'cmd.exe' : 'npm',
    isWindows ? ['/d', '/s', '/c', 'npm run typecheck'] : ['run', 'typecheck'],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
    },
  );
});
