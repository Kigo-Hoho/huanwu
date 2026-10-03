import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { ItemsModule } from './items/items.module.js';
import { StorageModule } from './storage/storage.module.js';
import { ProposalsModule } from './proposals/proposals.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { TestingIntegrationsController } from './integrations/testing-integrations.controller.js';

@Module({
  imports: [DatabaseModule, AuthModule, AuditModule, ItemsModule, StorageModule, ProposalsModule, OrdersModule, IntegrationsModule, PaymentsModule],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
  ],
})
export class AppModule {
  static forEnvironment(): DynamicModule {
    return { module: AppModule, controllers: ['development', 'test'].includes(process.env.NODE_ENV ?? '') && process.env.PAYMENT_PROVIDER === 'simulated' ? [TestingIntegrationsController] : [] };
  }
}
