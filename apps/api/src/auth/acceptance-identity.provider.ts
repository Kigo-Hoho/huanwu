import { Injectable, UnauthorizedException } from '@nestjs/common';

import type { CustomerIdentityProvider } from './wechat-identity.provider.js';

@Injectable()
export class AcceptanceIdentityProvider implements CustomerIdentityProvider {
  async exchangeCode(code: string): Promise<{ openid: string }> {
    if (code !== 'e2e-customer-code') {
      throw new UnauthorizedException('Invalid acceptance identity code');
    }
    return { openid: 'local-seed-customer' };
  }
}
