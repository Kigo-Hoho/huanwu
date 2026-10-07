import assert from 'node:assert/strict';
import test from 'node:test';

test('acceptance runtime keeps generated API secrets out of frontend environments', async () => {
  const { acceptanceEnvironment } = await import('./prepare-e2e.mjs');
  const source = { DATABASE_URL: 'postgresql://localhost/source', JWT_SECRET: 'a'.repeat(32), ADMIN_SEED_PASSWORD: 'test', E2E_REVIEWER_PASSWORD: 'test', ADDRESS_ENCRYPTION_KEY_BASE64: 'inherited-secret' };
  const owned = 'postgresql://localhost/barter_p3_0123456789abcdef_0123456789ab';
  const runtime = acceptanceEnvironment(source, owned, 'owned-images');
  assert.equal(source.ADDRESS_ENCRYPTION_KEY_BASE64, 'inherited-secret');
  assert.equal(runtime.browser.DATABASE_URL, undefined);
  assert.equal(runtime.frontend.ADDRESS_ENCRYPTION_KEY_BASE64, undefined);
  assert.equal(runtime.frontend.SIMULATED_INTEGRATION_SIGNING_KEY_BASE64, undefined);
  assert.equal(runtime.frontend.E2E_REVIEWER_PASSWORD, undefined);
  assert.equal(runtime.browser.E2E_REVIEWER_PASSWORD, 'test');
  assert.equal(runtime.api.DATABASE_URL, owned);
  assert.equal(Buffer.from(runtime.api.ADDRESS_ENCRYPTION_KEY_BASE64, 'base64').length, 32);
  assert.notEqual(runtime.api.ADDRESS_ENCRYPTION_KEY_BASE64, runtime.api.SIMULATED_INTEGRATION_SIGNING_KEY_BASE64);
});

test('acceptance refuses a source or non-owned target before constructing API credentials', async () => {
  const { acceptanceEnvironment } = await import('./prepare-e2e.mjs');
  const source = { DATABASE_URL: 'postgresql://localhost/source' };
  assert.throws(() => acceptanceEnvironment(source, source.DATABASE_URL, 'images'), /owned/);
  assert.throws(() => acceptanceEnvironment(source, 'postgresql://localhost/external', 'images'), /owned/);
  assert.throws(() => acceptanceEnvironment(source, 'invalid-with-secret', 'images'), error => error.message === 'Acceptance requires a distinct owned database');
});

test('owned lifecycle awaits cleanup and proof after browser failure and exposes cleanup failure', async () => {
  const { withOwnedDatabase } = await import('./prepare-e2e.mjs');
  const events = [];
  await assert.rejects(withOwnedDatabase({ close: async () => { await Promise.resolve(); events.push('drop'); } }, async () => { events.push('browser'); throw Error('browser failed'); }, async () => { events.push('proof'); }), /setup/);
  assert.deepEqual(events, ['browser', 'drop', 'proof']);
  await assert.rejects(withOwnedDatabase({ close: async () => { throw Error('drop failed'); } }, async () => {}, async () => {}), /cleanup/);
});

for (const failing of ['setup', 'cleanup', 'proof']) {
  test(`owned acceptance labels ${failing} safely and still attempts cleanup and proof`, async () => {
    const { withOwnedDatabase } = await import('./prepare-e2e.mjs');
    const events = [];
    const step = name => async () => { await Promise.resolve(); events.push(name); if (name === failing) throw Error('postgresql://private:password@host/database private-address'); };
    await assert.rejects(withOwnedDatabase({ close: step('cleanup') }, step('setup'), step('proof')), error => {
      assert.match(error.message, new RegExp(`E2E failed stages: ${failing}`));
      assert.doesNotMatch(error.message, /password|private|postgresql/); return true;
    });
    assert.deepEqual(events, ['setup', 'cleanup', 'proof']);
  });
}
test('owned acceptance preserves simultaneous failure categories without raw driver text', async () => {
  const { withOwnedDatabase } = await import('./prepare-e2e.mjs');
  const fail = async () => { throw Error('secret-driver-detail'); };
  await assert.rejects(withOwnedDatabase({ close: fail }, fail, fail), error => {
    assert.equal(error.message, 'E2E failed stages: setup, cleanup, proof'); assert.equal(error.errors.length, 3); return true;
  });
});
test('real failed child is categorized and owned cleanup and proof are awaited', async () => {
  const { command, withOwnedDatabase, safeAcceptanceFailure } = await import('./prepare-e2e.mjs');
  const events = [];
  await assert.rejects(withOwnedDatabase({ close: async () => { events.push('cleanup'); } },
    () => command(['-e', 'process.exitCode = 7'], process.env), async () => { events.push('proof'); }), error => {
    assert.equal(safeAcceptanceFailure(error), 'E2E failed stages: child'); return true;
  });
  assert.deepEqual(events, ['cleanup', 'proof']);
  assert.equal(safeAcceptanceFailure(Error('postgresql://secret')), 'E2E failed stages: setup');
});
