import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClockModule } from '../common/clock.module.js';
import { EvidenceModule } from '../evidence/evidence.module.js';
import { OperatorSecurityModule } from '../operator-security/operator-security.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { RiskController } from './risk.controller.js';
import { AdminRiskController } from './admin-risk.controller.js';
import { RiskReportService } from './risk-report.service.js';
import { RiskActionsService } from './risk-actions.service.js';
import { RiskTaskService } from './risk-task.service.js';
import { TradingRestrictionsModule } from './trading-restrictions.module.js';
@Module({ imports: [AuthModule, AuditModule, ClockModule, EvidenceModule, OperatorSecurityModule, OrdersModule, TradingRestrictionsModule], controllers: [RiskController, AdminRiskController], providers: [RiskReportService, RiskActionsService, RiskTaskService], exports: [RiskTaskService] })
export class RiskModule {}
