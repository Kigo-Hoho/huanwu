import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { AcceptanceIdentityProvider } from './acceptance-identity.provider.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';
import { CustomerOnlyGuard } from './customer-only.guard.js';
import {
  CUSTOMER_IDENTITY_PROVIDER,
  WechatIdentityProvider,
  type CustomerIdentityProvider,
} from './wechat-identity.provider.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    RolesGuard,
    CustomerOnlyGuard,
    WechatIdentityProvider,
    AcceptanceIdentityProvider,
    {
      provide: CUSTOMER_IDENTITY_PROVIDER,
      inject: [WechatIdentityProvider, AcceptanceIdentityProvider],
      useFactory: (
        wechat: WechatIdentityProvider,
        acceptance: AcceptanceIdentityProvider,
      ): CustomerIdentityProvider => {
        const provider = process.env.WECHAT_IDENTITY_PROVIDER ?? 'wechat';
        if (provider === 'wechat') return wechat;
        if (provider !== 'acceptance') {
          throw new Error(`Unknown customer identity provider: ${provider}`);
        }
        if (process.env.NODE_ENV !== 'test') {
          throw new Error(
            'The acceptance identity provider is available only when NODE_ENV=test.',
          );
        }
        return acceptance;
      },
    },
  ],
  exports: [AuthService, JwtAuthGuard, RolesGuard, CustomerOnlyGuard],
})
export class AuthModule {}
