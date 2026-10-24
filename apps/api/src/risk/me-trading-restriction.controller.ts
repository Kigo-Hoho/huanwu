import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RiskReportService } from './risk-report.service.js';

@Controller()
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class MeTradingRestrictionController {
  constructor(@Inject(RiskReportService) private readonly reports: RiskReportService) {}

  @Get('me/trading-restriction')
  current(@CurrentUser() actor: AuthenticatedUser) {
    return this.reports.myRestriction(actor);
  }
}
