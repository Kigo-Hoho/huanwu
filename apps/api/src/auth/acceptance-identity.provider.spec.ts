import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcceptanceIdentityProvider } from './acceptance-identity.provider.js';

describe('acceptance two-customer identity', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('maps two explicit codes to stable independent users', async () => {
    const provider = new AcceptanceIdentityProvider();
    await expect(provider.exchangeCode('e2e-customer-code')).resolves.toEqual({ openid: 'local-seed-customer' });
    await expect(provider.exchangeCode('e2e-customer-two-code')).resolves.toEqual({ openid: 'local-seed-customer-two' });
    await expect(provider.exchangeCode('e2e-customer-two-code')).resolves.toEqual({ openid: 'local-seed-customer-two' });
    await expect(provider.exchangeCode('arbitrary-code')).rejects.toThrow();
  });
  it('cannot exchange identities outside the explicitly selected test environment', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(new AcceptanceIdentityProvider().exchangeCode('e2e-customer-code')).rejects.toThrow();
  });
});
