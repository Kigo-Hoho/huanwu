import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClockModule } from '../common/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { OperatorSecurityModule } from '../operator-security/operator-security.module.js';
import { AdminResolutionController } from './admin-after-sales.controller.js';
import { AdminAfterSalesService } from './admin-after-sales.service.js';
import { ResolutionService } from './resolution.service.js';
import { AdminAfterSalesController, AfterSalesController } from './after-sales.controller.js';
import { AfterSalesService } from './after-sales.service.js';
import { CaseCommandsService } from './case-commands.service.js';
import { CaseRecordsService } from './case-records.service.js';

@Module({
  imports: [DatabaseModule, AuthModule, AuditModule, ClockModule, OrdersModule, OperatorSecurityModule],
  controllers: [AfterSalesController, AdminAfterSalesController, AdminResolutionController],
  providers: [AfterSalesService, CaseCommandsService, CaseRecordsService, ResolutionService, AdminAfterSalesService],
  exports: [AfterSalesService, CaseCommandsService, CaseRecordsService, ResolutionService],
})
export class AfterSalesModule {}
