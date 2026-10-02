import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('database-free policy test selection', () => {
  it.each(['src/reservations/reservation-policy.spec.ts', 'src/orders/order-policy.spec.ts'])('runs %s without database configuration', (testFile) => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    for (const key of Object.keys(env)) {
      if (key.startsWith('PHASE3_')) delete env[key];
    }
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', testFile], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    // Only status is exposed: runner output must never leak inherited credentials.
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.includes('Test Files')).toBe(true);
  }, 40000);
});
