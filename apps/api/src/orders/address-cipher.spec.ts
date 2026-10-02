import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddressCipher } from './address-cipher.js';

const context = { orderId: randomUUID(), side: 'INITIATOR' as const, version: 1 };
const address = { ...context, recipientName: '测试收件人', phone: '13800138001', region: '上海市浦东新区', detail: '隐私测试路123号456室' };
beforeEach(() => {
  vi.stubEnv('ADDRESS_ENCRYPTION_KEY_BASE64', randomBytes(32).toString('base64'));
  vi.stubEnv('ADDRESS_ENCRYPTION_KEY_VERSION', 'test-v1');
});
afterEach(() => { vi.unstubAllEnvs(); });

it('round trips only authenticated addresses with a fresh 12-byte nonce and 16-byte tag', () => {
  const cipher = new AddressCipher();
  const first = cipher.encrypt(address, context); const second = cipher.encrypt(address, context);
  expect(cipher.decrypt(first, context)).toEqual(address);
  expect(first.keyVersion).toBe('test-v1');
  expect(first.nonce).toHaveLength(12); expect(first.tag).toHaveLength(16);
  expect(first.nonce).not.toEqual(second.nonce); expect(first.ciphertext).not.toEqual(second.ciphertext);
  expect(Buffer.from(first.ciphertext).toString('utf8')).not.toContain(address.phone);
});
it('rejects ciphertext replay into a different order, side or address version', () => {
  const cipher = new AddressCipher(); const encrypted = cipher.encrypt(address, context);
  for (const other of [{ ...context, orderId: randomUUID() }, { ...context, side: 'RECIPIENT' as const }, { ...context, version: 2 }]) {
    expect(() => cipher.decrypt(encrypted, other)).toThrow();
  }
  expect(() => cipher.encrypt({ ...address, version: 2 }, context)).toThrow();
});
it('fails closed on wrong keys, key versions and authenticated byte tampering', () => {
  const cipher = new AddressCipher(); const encrypted = cipher.encrypt(address, context);
  for (const field of ['nonce', 'tag', 'ciphertext'] as const) {
    const damaged = Buffer.from(encrypted[field]); damaged[0] ^= 1;
    expect(() => cipher.decrypt({ ...encrypted, [field]: damaged }, context)).toThrow();
  }
  expect(() => cipher.decrypt({ ...encrypted, keyVersion: 'unavailable-v2' }, context)).toThrow();
  vi.stubEnv('ADDRESS_ENCRYPTION_KEY_BASE64', randomBytes(32).toString('base64'));
  expect(() => cipher.decrypt(encrypted, context)).toThrow();
});
it('rejects malformed encryption envelopes, contexts and authenticated non-address plaintext', () => {
  const cipher = new AddressCipher(); const encrypted = cipher.encrypt(address, context);
  for (const malformed of [{ nonce: Buffer.alloc(11) }, { tag: Buffer.alloc(15) }, { tag: Buffer.alloc(17) }, { ciphertext: Buffer.alloc(0) }, { ciphertext: Buffer.alloc(10000) }]) {
    expect(() => cipher.decrypt({ ...encrypted, ...malformed }, context)).toThrow();
  }
  for (const malformed of [{ ...context, orderId: 'invalid' }, { ...context, version: 0 }, { ...context, version: 1.5 }]) expect(() => cipher.decrypt(encrypted, malformed)).toThrow();
  // Use the public AAD format to build valid authentication around invalid JSON/data.
  for (const plaintext of ['not-json', JSON.stringify({ ...address, phone: '', version: 2 }), JSON.stringify({ ...address, extra: 'private' })]) {
    const nonce = randomBytes(12);
    const raw = createCipheriv('aes-256-gcm', Buffer.from(process.env.ADDRESS_ENCRYPTION_KEY_BASE64!, 'base64'), nonce, { authTagLength: 16 });
    raw.setAAD(Buffer.from(JSON.stringify(['order-address-v1', context.orderId, context.side, context.version, 'test-v1'])));
    const ciphertext = Buffer.concat([raw.update(plaintext, 'utf8'), raw.final()]);
    expect(() => cipher.decrypt({ keyVersion: 'test-v1', nonce, tag: raw.getAuthTag(), ciphertext }, context)).toThrow();
  }
});
it('keeps construction independent of configuration and rejects absent or malformed keys with 503', () => {
  const cipher = new AddressCipher();
  for (const key of [undefined, '', 'replace-with-base64-key', randomBytes(31).toString('base64'), `${randomBytes(32).toString('base64')}!`]) {
    vi.stubEnv('ADDRESS_ENCRYPTION_KEY_BASE64', key);
    try { cipher.encrypt(address, context); expect.fail('must refuse encryption'); }
    catch (error) { expect((error as { getStatus(): number }).getStatus()).toBe(503); }
  }
  vi.stubEnv('ADDRESS_ENCRYPTION_KEY_BASE64', randomBytes(32).toString('base64'));
  for (const version of [undefined, '', ' '.repeat(2), 'x'.repeat(101)]) {
    vi.stubEnv('ADDRESS_ENCRYPTION_KEY_VERSION', version);
    expect(() => cipher.encrypt(address, context)).toThrow();
  }
});
it('rejects authenticated invalid UTF-8 instead of silently replacing private data bytes', () => {
  const nonce = randomBytes(12);
  const raw = createCipheriv('aes-256-gcm', Buffer.from(process.env.ADDRESS_ENCRYPTION_KEY_BASE64!, 'base64'), nonce, { authTagLength: 16 });
  raw.setAAD(Buffer.from(JSON.stringify(['order-address-v1', context.orderId, context.side, context.version, 'test-v1'])));
  const invalidUtf8 = Buffer.concat([Buffer.from(JSON.stringify(address).slice(0, -1) + ',"detail":"invalid'), Buffer.from([0xff]), Buffer.from('address"}')]);
  const ciphertext = Buffer.concat([raw.update(invalidUtf8), raw.final()]);
  expect(() => new AddressCipher().decrypt({ keyVersion: 'test-v1', nonce, tag: raw.getAuthTag(), ciphertext }, context)).toThrow();
});
