import type { ApiErrorCode } from '@barter/contracts';
import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

interface WechatCodeExchangeResponse {
  openid?: unknown;
  errcode?: unknown;
  errmsg?: unknown;
}

export interface CustomerIdentityProvider {
  exchangeCode(code: string): Promise<{ openid: string }>;
}

export const CUSTOMER_IDENTITY_PROVIDER = Symbol('CUSTOMER_IDENTITY_PROVIDER');
const identityExchangeTimeoutMs = 5_000;
const identityProviderUnavailableCode: ApiErrorCode =
  'IDENTITY_PROVIDER_UNAVAILABLE';

function identityProviderError(message: string) {
  return {
    code: identityProviderUnavailableCode,
    message,
  };
}

@Injectable()
export class WechatIdentityProvider implements CustomerIdentityProvider {
  async exchangeCode(code: string): Promise<{ openid: string }> {
    const appId = process.env.WECHAT_APP_ID;
    const appSecret = process.env.WECHAT_APP_SECRET;
    if (!appId?.trim() || !appSecret?.trim()) {
      throw new ServiceUnavailableException(
        identityProviderError('WeChat identity provider is not configured'),
      );
    }

    const query = new URLSearchParams({
      appid: appId,
      secret: appSecret,
      js_code: code,
      grant_type: 'authorization_code',
    });
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      identityExchangeTimeoutMs,
    );
    try {
      let response: Response;
      try {
        response = await fetch(
          `https://api.weixin.qq.com/sns/jscode2session?${query.toString()}`,
          { signal: abortController.signal },
        );
      } catch {
        if (abortController.signal.aborted) {
          throw new GatewayTimeoutException(
            identityProviderError('WeChat identity exchange timed out'),
          );
        }
        throw new BadGatewayException(
          identityProviderError('WeChat identity exchange failed'),
        );
      }
      if (!response.ok) {
        throw new BadGatewayException(
          identityProviderError('WeChat identity exchange failed'),
        );
      }

      let result: WechatCodeExchangeResponse;
      try {
        result = (await response.json()) as WechatCodeExchangeResponse;
      } catch {
        if (abortController.signal.aborted) {
          throw new GatewayTimeoutException(
            identityProviderError('WeChat identity exchange timed out'),
          );
        }
        throw new BadGatewayException(
          identityProviderError(
            'WeChat identity exchange returned invalid data',
          ),
        );
      }
      if (typeof result.openid !== 'string' || !result.openid) {
        throw new BadGatewayException(
          identityProviderError('WeChat identity exchange was rejected'),
        );
      }

      return { openid: result.openid };
    } finally {
      clearTimeout(timeout);
    }
  }
}
