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
import { ResolutionApprovalService } from './resolution-approval.service.js';
import { ResolutionExecutionService } from './resolution-execution.service.js';
import { RESOLUTION_EXECUTORS } from './resolution-executor.port.js';
import { OrderInterventionService } from './order-intervention.service.js';
import { CaseFinalizationService } from './case-finalization.service.js';
import { CaseFundsStatusService } from '../compensation/case-funds-status.service.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { InterventionCommandsService } from './intervention-commands.service.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { RiskTaskService } from '../risk/risk-task.service.js';
import { CaseExpiryService } from './case-expiry.service.js';
import { CaseExpiryScheduler } from './case-expiry.scheduler.js';

@Module({
  imports: [DatabaseModule, AuthModule, AuditModule, ClockModule, OrdersModule, OperatorSecurityModule, ReservationsModule, PaymentsModule],
  controllers: [AfterSalesController, AdminAfterSalesController, AdminResolutionController],
  providers: [InterventionCommandsService, OrderInterventionService, CaseFinalizationService, CaseFundsStatusService, AfterSalesService, CaseCommandsService, CaseRecordsService, ResolutionService, AdminAfterSalesService, ResolutionApprovalService, ResolutionExecutionService, RiskTaskService, CaseExpiryService, CaseExpiryScheduler,
    { provide: RESOLUTION_EXECUTORS, useFactory: () => new Map() }],
  exports: [OrderInterventionService, CaseFinalizationService, AfterSalesService, CaseCommandsService, CaseRecordsService, ResolutionService, ResolutionApprovalService, ResolutionExecutionService, CaseExpiryService, RESOLUTION_EXECUTORS],
})
export class AfterSalesModule {}
