import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

interface WechatCodeExchangeResponse {
  openid?: unknown;
  errcode?: unknown;
  errmsg?: unknown;
}

@Injectable()
export class WechatIdentityProvider {
  async exchangeCode(code: string): Promise<{ openid: string }> {
    const appId = process.env.WECHAT_APP_ID;
    const appSecret = process.env.WECHAT_APP_SECRET;
    if (!appId?.trim() || !appSecret?.trim()) {
      throw new ServiceUnavailableException(
        'WeChat identity provider is not configured',
      );
    }

    const query = new URLSearchParams({
      appid: appId,
      secret: appSecret,
      js_code: code,
      grant_type: 'authorization_code',
    });
    const response = await fetch(
      `https://api.weixin.qq.com/sns/jscode2session?${query.toString()}`,
    );
    if (!response.ok) {
      throw new BadGatewayException('WeChat identity exchange failed');
    }

    const result = (await response.json()) as WechatCodeExchangeResponse;
    if (typeof result.openid !== 'string' || !result.openid) {
      throw new BadGatewayException('WeChat identity exchange was rejected');
    }

    return { openid: result.openid };
  }
}
