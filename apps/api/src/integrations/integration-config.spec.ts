import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { selectIntegration, integrationConfiguration } from './integration-config.js';
import { SimulatedProviderStore } from './simulated-provider.store.js';
import { SimulatedPaymentAdapter } from './simulated-payment.adapter.js';
import { SimulatedLogisticsAdapter } from './simulated-logistics.adapter.js';
import type { PrismaService } from '../database/prisma.service.js';
import { SystemClock } from '../common/clock.js';
import type { ProviderOperation } from './integration.types.js';

afterEach(() => vi.unstubAllEnvs());
it.each(['development', 'test'])('allows explicit simulation only in %s', nodeEnv => {
  expect(selectIntegration({ nodeEnv, provider: 'simulated' })).toBe('simulated');
});
it('disabled payment/logistics ports reject every capability with 503 before any database call', async () => {
  const store = new SimulatedProviderStore({} as PrismaService, new SystemClock(), { payment: 'disabled', logistics: 'disabled' });
  const payment = new SimulatedPaymentAdapter(store); const logistics = new SimulatedLogisticsAdapter(store);
  const op: ProviderOperation = { businessNo: 'unused', orderId: 'unused', kind: 'CREATE_PAYMENT', payload: {} };
  for (const call of [() => payment.checkout('unused'), () => payment.createPayment(op), () => payment.closePayment(op), () => payment.refundPayment(op), () => payment.settleDifference(op), () => payment.queryPayment('unused'), () => payment.queryRefund('unused'), () => payment.querySettlement('unused'), () => logistics.verifyShipment(op), () => logistics.queryShipment('unused')]) {
    await expect(call()).rejects.toMatchObject({ status: 503 });
  }
  expect(() => payment.verifySignedEvent('{}', '')).toThrow();
  expect(() => logistics.verifySignedEvent('{}', '')).toThrow();
});
it.each(['production', 'staging', ''])('rejects simulation in %s', nodeEnv => {
  expect(() => selectIntegration({ nodeEnv, provider: 'simulated' })).toThrow();
});
it.each(['stripe', 'SIMULATED', ' simulated', ''])('rejects unknown provider %s', provider => {
  expect(() => selectIntegration({ nodeEnv: 'test', provider })).toThrow();
});
it('defaults missing capabilities to disabled and preserves production startup without new capabilities', () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('PAYMENT_PROVIDER', undefined); vi.stubEnv('LOGISTICS_PROVIDER', undefined);
  expect(integrationConfiguration()).toMatchObject({ payment: 'disabled', logistics: 'disabled' });
  expect(selectIntegration({ nodeEnv: 'test', provider: 'disabled' })).toBe('disabled');
  expect(selectIntegration({ nodeEnv: 'production', provider: 'disabled' })).toBe('disabled');
});
it('requires a canonical 32-byte runtime key for simulation', () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('PAYMENT_PROVIDER', 'simulated'); vi.stubEnv('LOGISTICS_PROVIDER', 'disabled');
  for (const invalid of [undefined, '', 'invalid', randomBytes(31).toString('base64')]) {
    vi.stubEnv('SIMULATED_INTEGRATION_SIGNING_KEY_BASE64', invalid);
    expect(() => integrationConfiguration()).toThrow();
  }
  vi.stubEnv('SIMULATED_INTEGRATION_SIGNING_KEY_BASE64', randomBytes(32).toString('base64'));
  expect(integrationConfiguration()).toMatchObject({ payment: 'simulated', logistics: 'disabled' });
});
