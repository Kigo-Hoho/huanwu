import { Module } from '@nestjs/common';
import { AfterSalesModule } from '../after-sales/after-sales.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClockModule } from '../common/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { AddressCipher } from '../orders/address-cipher.js';
import { RiskTaskService } from '../risk/risk-task.service.js';
import { ReturnAddressService } from './return-address.service.js';
import { ReturnCommandsService } from './return-commands.service.js';
import { ReturnEventsService } from './return-events.service.js';
import { ReturnLogisticsHandler } from './return-logistics.handler.js';
import { ReturnPlanService } from './return-plan.service.js';
import { ReturnsController } from './returns.controller.js';
import { ReturnSimulationService } from './return-simulation.service.js';
@Module({ imports: [AfterSalesModule, AuditModule, AuthModule, ClockModule, DatabaseModule, IntegrationsModule], controllers: [ReturnsController], providers: [AddressCipher, RiskTaskService, ReturnAddressService, ReturnCommandsService, ReturnEventsService, ReturnLogisticsHandler, ReturnPlanService, ReturnSimulationService], exports: [ReturnAddressService, ReturnCommandsService, ReturnEventsService, ReturnPlanService] })
export class ReturnsModule {}
