import { Module } from '@nestjs/common';
import { AfterSalesModule } from '../after-sales/after-sales.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClockModule } from '../common/clock.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { CompensationController } from './compensation.controller.js';
import { CompensationService } from './compensation.service.js';
import { COMPENSATION_PORT, SimulatedCompensationAdapter } from './compensation.port.js';
import { CompensationOutboxHandler } from './compensation-outbox.handler.js';
import { CompensationEventsService } from './compensation-events.service.js';
import { CompensationSimulationService } from './compensation-simulation.service.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { FinancialEventReconciler } from './financial-event-reconciler.js';
import { CaseFundsStatusService } from './case-funds-status.service.js';
import { ReturnsModule } from '../returns/returns.module.js';
@Module({ imports: [AfterSalesModule, AuditModule, AuthModule, ClockModule, IntegrationsModule, PaymentsModule, ReturnsModule], controllers: [CompensationController], providers: [CaseFundsStatusService, { provide: 'CASE_FUNDS_STATUS', useExisting: CaseFundsStatusService }, FinancialEventReconciler, CompensationService, CompensationEventsService, CompensationSimulationService, CompensationOutboxHandler, SimulatedCompensationAdapter, { provide: COMPENSATION_PORT, useExisting: SimulatedCompensationAdapter }], exports: [CaseFundsStatusService, CompensationSimulationService, CompensationEventsService, COMPENSATION_PORT] })
export class CompensationModule {}
