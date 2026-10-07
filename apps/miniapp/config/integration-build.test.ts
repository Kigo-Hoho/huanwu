import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
it.each([
  { environment: 'production', identity: 'taro', target: 'weapp', mode: 'simulated', want: /simulated.*development.*acceptance/i },
  { environment: 'development', identity: 'taro', target: 'weapp', mode: 'simulated', want: /simulated.*development.*acceptance/i },
  { environment: 'acceptance', identity: 'taro', target: 'h5', mode: 'simulated', want: /simulated.*development.*acceptance/i },
  { environment: 'acceptance', identity: 'acceptance', target: 'weapp', mode: 'simulated', want: /simulated.*development.*acceptance/i },
  { environment: '', identity: 'taro', target: 'h5', mode: 'simulated', want: /simulated.*development.*acceptance/i },
  { environment: 'development', identity: 'taro', target: 'h5', mode: 'typo', want: /unknown integration mode/i },
])('rejects real Taro build flags $environment/$identity/$target/$mode', ({ environment, identity, target, mode, want }) => {
  const result = spawnSync(process.execPath, [resolve('../../node_modules/@tarojs/cli/bin/taro'), 'build', '--type', target], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, NODE_ENV: 'production', TARO_ENV: target, TARO_APP_ENVIRONMENT: environment, TARO_APP_IDENTITY_PROVIDER: identity, TARO_APP_INTEGRATION_MODE: mode },
  });
  expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(want);
}, 65000);
