import { Injectable, UnauthorizedException } from '@nestjs/common';

import type { CustomerIdentityProvider } from './wechat-identity.provider.js';

@Injectable()
export class AcceptanceIdentityProvider implements CustomerIdentityProvider {
  async exchangeCode(code: string): Promise<{ openid: string }> {
    if (process.env.NODE_ENV !== 'test') {
      throw new UnauthorizedException('Acceptance identities require NODE_ENV=test');
    }
    const identities: Record<string, string> = {
      'e2e-customer-code': 'local-seed-customer',
      'e2e-customer-two-code': 'local-seed-customer-two',
    };
    const openid = Object.hasOwn(identities, code) ? identities[code] : undefined;
    if (!openid) {
      throw new UnauthorizedException('Invalid acceptance identity code');
    }
    return { openid };
  }
}
