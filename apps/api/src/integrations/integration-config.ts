import { ServiceUnavailableException } from '@nestjs/common';

export const INTEGRATION_CONFIG = Symbol('INTEGRATION_CONFIG');
export const integrationUnavailable = () => new ServiceUnavailableException({ code: 'INTEGRATION_UNAVAILABLE', message: 'Integration capability is unavailable' });
export function selectIntegration({ nodeEnv, provider }: { nodeEnv: string; provider: string }): 'disabled' | 'simulated' {
  if (provider !== 'disabled' && provider !== 'simulated') throw integrationUnavailable();
  if (provider === 'simulated' && !['development', 'test'].includes(nodeEnv)) throw integrationUnavailable();
  return provider;
}
export interface IntegrationConfiguration { payment: 'disabled' | 'simulated'; logistics: 'disabled' | 'simulated'; signingKey?: Buffer }
export function integrationConfiguration(): IntegrationConfiguration {
  const nodeEnv = process.env.NODE_ENV ?? '';
  const payment = selectIntegration({ nodeEnv, provider: process.env.PAYMENT_PROVIDER ?? 'disabled' });
  const logistics = selectIntegration({ nodeEnv, provider: process.env.LOGISTICS_PROVIDER ?? 'disabled' });
  if (payment === 'disabled' && logistics === 'disabled') return { payment, logistics };
  const encoded = process.env.SIMULATED_INTEGRATION_SIGNING_KEY_BASE64;
  if (!encoded) throw integrationUnavailable();
  const signingKey = Buffer.from(encoded, 'base64');
  if (signingKey.length !== 32 || signingKey.toString('base64') !== encoded) throw integrationUnavailable();
  return { payment, logistics, signingKey };
}
