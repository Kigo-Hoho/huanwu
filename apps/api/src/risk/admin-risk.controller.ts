import { ClearOrderRiskInputSchema, ConcludeRiskReportSchema, RiskActionInputSchema, RiskReportCommandSchema, type ClearOrderRiskInput, type ConcludeRiskReportInput, type RiskActionInput, type RiskReportCommand } from '@barter/contracts';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { requireOperatorSession } from '../operator-security/operator-security.controller.js';
import { assertOperatorOrigin } from '../operator-security/operator-session.service.js';
import { RiskReportService } from './risk-report.service.js';
import { RiskActionsService } from './risk-actions.service.js';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('REVIEWER', 'SUPER_ADMIN')
export class AdminRiskController {
  constructor(@Inject(RiskReportService) private readonly reports: RiskReportService, @Inject(RiskActionsService) private readonly actions: RiskActionsService) {}
  @Get('reports') list(@Req() r: AuthenticatedRequest, @Query() q: unknown) { return this.reports.list(requireOperatorSession(r), q); }
  @Get('reports/:id') detail(@Req() r: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.reports.detail(requireOperatorSession(r), id.toLowerCase()); }
  @Get('risk-tasks') tasks(@Req() r: AuthenticatedRequest, @Query() q: unknown) { return this.reports.tasks(requireOperatorSession(r), q); }
  @Get('risk-tasks/:id') task(@Req() r: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.reports.tasks(requireOperatorSession(r), {}, id.toLowerCase()); }
  @Get('risk/users/:id') restriction(@Req() r: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) { return this.reports.restriction(requireOperatorSession(r), id.toLowerCase()); }
  @Post('reports/:id/claim') @HttpCode(200)
  claim(@Req() r: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(RiskReportCommandSchema)) input: RiskReportCommand, @Headers('idempotency-key') key: string) { assertOperatorOrigin(r); return this.reports.process(requireOperatorSession(r), id.toLowerCase(), 'claim', input, key); }
  @Post('reports/:id/request-evidence') @HttpCode(200)
  request(@Req() r: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(RiskReportCommandSchema)) input: RiskReportCommand, @Headers('idempotency-key') key: string) { assertOperatorOrigin(r); return this.reports.process(requireOperatorSession(r), id.toLowerCase(), 'request-evidence', input, key); }
  @Post('reports/:id/conclude') @HttpCode(200)
  conclude(@Req() r: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(ConcludeRiskReportSchema)) input: ConcludeRiskReportInput, @Headers('idempotency-key') key: string) { assertOperatorOrigin(r); return this.reports.process(requireOperatorSession(r), id.toLowerCase(), 'conclude', input, key); }
  @Post('risk/users/:id/freeze') @HttpCode(200)
  freeze(@Req() r: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(RiskActionInputSchema)) input: RiskActionInput, @Headers('idempotency-key') key: string) { assertOperatorOrigin(r); return this.actions.freeze({ ...requireOperatorSession(r), grantId: input.operatorAction.grantId }, id.toLowerCase(), input, key); }
  @Post('risk/users/:id/unfreeze') @HttpCode(200)
  unfreeze(@Req() r: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(RiskActionInputSchema)) input: RiskActionInput, @Headers('idempotency-key') key: string) { assertOperatorOrigin(r); return this.actions.unfreeze({ ...requireOperatorSession(r), grantId: input.operatorAction.grantId }, id.toLowerCase(), input, key); }
  @Post('risk/items/:id/unpublish') @HttpCode(200)
  unpublish(@Req() r: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(RiskActionInputSchema)) input: RiskActionInput, @Headers('idempotency-key') key: string) { assertOperatorOrigin(r); return this.actions.unpublish({ ...requireOperatorSession(r), grantId: input.operatorAction.grantId }, id.toLowerCase(), input, key); }
  @Post('risk/items/:id/clear-block') @HttpCode(200)
  clearItem(@Req() r: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(RiskActionInputSchema)) input: RiskActionInput, @Headers('idempotency-key') key: string) { assertOperatorOrigin(r); return this.actions.clearItem({ ...requireOperatorSession(r), grantId: input.operatorAction.grantId }, id.toLowerCase(), input, key); }
  @Post('risk/orders/:id/pause') @HttpCode(200)
  pause(@Req() r: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(RiskActionInputSchema)) input: RiskActionInput, @Headers('idempotency-key') key: string) { assertOperatorOrigin(r); return this.actions.pause({ ...requireOperatorSession(r), grantId: input.operatorAction.grantId }, id.toLowerCase(), input, key); }
  @Post('risk/orders/:id/clear-block') @HttpCode(200)
  clearOrder(@Req() r: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(ClearOrderRiskInputSchema)) input: ClearOrderRiskInput, @Headers('idempotency-key') key: string) { assertOperatorOrigin(r); return this.actions.clearOrder({ ...requireOperatorSession(r), grantId: input.operatorAction.grantId }, id.toLowerCase(), input, key); }
}
