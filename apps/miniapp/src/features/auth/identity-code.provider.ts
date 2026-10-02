import Taro from '@tarojs/taro';

export interface IdentityCodeProvider {
  getCode(): Promise<string>;
}

type Login = () => Promise<{ code?: string }>;

export class TaroIdentityCodeProvider implements IdentityCodeProvider {
  constructor(private readonly login: Login = () => Taro.login()) {}

  async getCode(): Promise<string> {
    const result = await this.login();
    const code = result.code?.trim();
    if (!code) throw new Error('微信登录未返回有效身份码。');
    return code;
  }
}

export class AcceptanceH5IdentityCodeProvider implements IdentityCodeProvider {
  async getCode(): Promise<string> {
    if (!__ACCEPTANCE_IDENTITY_CODE__) {
      throw new Error('The acceptance identity code was not enabled for this build.');
    }
    const code = typeof __BARTER_ACCEPTANCE_IDENTITY_CODE__ === 'undefined'
      ? __ACCEPTANCE_IDENTITY_CODE__
      : __BARTER_ACCEPTANCE_IDENTITY_CODE__;
    if (code !== 'e2e-customer-code' && code !== 'e2e-customer-two-code') {
      throw new Error('Invalid acceptance identity code.');
    }
    return code;
  }
}

export interface IdentityProviderConfiguration {
  provider: string;
  target: string;
  buildEnvironment: string;
}

export function createIdentityCodeProvider(
  configuration: IdentityProviderConfiguration,
  login?: Login,
): IdentityCodeProvider {
  if (configuration.provider === 'taro') {
    return new TaroIdentityCodeProvider(login);
  }
  if (configuration.provider !== 'acceptance') {
    throw new Error(`Unknown identity provider: ${configuration.provider}`);
  }
  if (configuration.target !== 'h5') {
    throw new Error('The acceptance identity provider is restricted to H5.');
  }
  if (configuration.buildEnvironment === 'production') {
    throw new Error('The acceptance identity provider is forbidden in production.');
  }
  return new AcceptanceH5IdentityCodeProvider();
}
