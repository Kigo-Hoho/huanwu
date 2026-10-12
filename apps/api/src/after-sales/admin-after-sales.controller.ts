import { ResolutionAdjudicationSchema, ResolutionApprovalSchema, ResolutionExecutionSchema, ResolutionInputSchema, type ResolutionAdjudicationInput, type ResolutionApprovalInput, type ResolutionExecutionInput, type ResolutionInput } from '@barter/contracts';
import { Body, Controller, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { requireOperatorSession } from '../operator-security/operator-security.controller.js';
import { assertOperatorOrigin } from '../operator-security/operator-session.service.js';
import { AdminAfterSalesService } from './admin-after-sales.service.js';
import { ResolutionApprovalService } from './resolution-approval.service.js';
import { ResolutionExecutionService } from './resolution-execution.service.js';

@Controller('admin/after-sales')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminResolutionController {
  constructor(@Inject(AdminAfterSalesService) private readonly cases: AdminAfterSalesService,
    @Inject(ResolutionApprovalService) private readonly approvals: ResolutionApprovalService,
    @Inject(ResolutionExecutionService) private readonly executions: ResolutionExecutionService) {}
  @Post(':id/approvals')
  @Roles('SUPER_ADMIN')
  @HttpCode(200)
  approve(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ResolutionApprovalSchema)) input: ResolutionApprovalInput, @Headers('idempotency-key') key: string) {
    assertOperatorOrigin(request);
    return this.approvals.approve({ ...requireOperatorSession(request), grantId: input.operatorAction.grantId }, id.toLowerCase(), input, key);
  }
  @Post(':id/execute')
  @Roles('SUPER_ADMIN')
  @HttpCode(200)
  execute(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ResolutionExecutionSchema)) input: ResolutionExecutionInput, @Headers('idempotency-key') key: string) {
    assertOperatorOrigin(request);
    return this.executions.start({ ...requireOperatorSession(request), grantId: input.operatorAction.grantId }, id.toLowerCase(), input, key);
  }
  @Post(':id/resolutions')
  @Roles('OPERATIONS', 'SUPER_ADMIN')
  @HttpCode(200)
  propose(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ResolutionInputSchema)) input: ResolutionInput, @Headers('idempotency-key') key: string) {
    assertOperatorOrigin(request);
    return this.cases.propose(requireOperatorSession(request), id.toLowerCase(), input, key);
  }
  @Post(':id/adjudication')
  @Roles('SUPER_ADMIN')
  @HttpCode(200)
  adjudicate(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ResolutionAdjudicationSchema)) input: ResolutionAdjudicationInput, @Headers('idempotency-key') key: string) {
    assertOperatorOrigin(request);
    return this.cases.adjudicate(requireOperatorSession(request), id.toLowerCase(), input, key);
  }
}
