import {
  CaseEvidenceRequestSchema, CaseListQuerySchema, CaseRejectSchema, CaseResponseSchema,
  CaseWithdrawalResponseSchema, CaseWithdrawalSchema, CreateCaseSchema,
  ResolutionConsentSchema, type ResolutionConsentInput,
  type CaseEvidenceRequestInput, type CaseListQuery, type CaseRejectInput,
  type CaseResponseInput, type CaseWithdrawalInput, type CaseWithdrawalResponseInput, type CreateCaseInput,
} from '@barter/contracts';
import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { requireOperatorSession } from '../operator-security/operator-security.controller.js';
import { assertOperatorOrigin } from '../operator-security/operator-session.service.js';
import { AfterSalesService } from './after-sales.service.js';
import { CaseRecordsService } from './case-records.service.js';
import { ResolutionService } from './resolution.service.js';

@Controller()
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class AfterSalesController {
  constructor(
    @Inject(AfterSalesService) private readonly cases: AfterSalesService,
    @Inject(CaseRecordsService) private readonly records: CaseRecordsService,
    @Inject(ResolutionService) private readonly resolutions: ResolutionService,
  ) {}
  @Post('orders/:id/after-sales')
  open(
    @CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(CreateCaseSchema)) input: CreateCaseInput,
    @Headers('idempotency-key') key: string, @Headers('x-request-id') requestId?: string,
  ) { return this.cases.open(actor, id.toLowerCase(), input, key, requestId); }

  @Get('after-sales')
  @Header('Cache-Control', 'no-store')
  list(@CurrentUser() actor: AuthenticatedUser, @Query(new ZodValidationPipe(CaseListQuerySchema)) query: CaseListQuery) {
    return this.cases.list(actor, query);
  }
  @Get('after-sales/:id')
  @Header('Cache-Control', 'no-store')
  detail(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.cases.detail(actor, id.toLowerCase());
  }
  @Post('after-sales/:id/response')
  @HttpCode(200)
  response(
    @CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(CaseResponseSchema)) input: CaseResponseInput,
    @Headers('idempotency-key') key: string, @Headers('x-request-id') requestId?: string,
  ) { return this.records.respond({ actor, caseId: id.toLowerCase(), input, key, requestId, commandName: 'CASE_RESPONSE_RECORDED' }, input); }

  @Post('after-sales/:id/consent')
  @HttpCode(200)
  consent(
    @CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ResolutionConsentSchema)) input: ResolutionConsentInput,
    @Headers('idempotency-key') key: string, @Headers('x-request-id') requestId?: string,
  ) { return this.resolutions.consent({ actor, caseId: id.toLowerCase(), input, key, requestId, commandName: 'CASE_RESOLUTION_CONSENT' }, input); }

  @Post('after-sales/:id/withdraw')
  @HttpCode(200)
  withdraw(
    @CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(CaseWithdrawalSchema)) input: CaseWithdrawalInput,
    @Headers('idempotency-key') key: string, @Headers('x-request-id') requestId?: string,
  ) { return this.records.withdraw({ actor, caseId: id.toLowerCase(), input, key, requestId, commandName: 'CASE_WITHDRAWAL_REQUESTED' }, input); }

  @Post('after-sales/:id/withdraw/respond')
  @HttpCode(200)
  withdrawalRespond(
    @CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(CaseWithdrawalResponseSchema)) input: CaseWithdrawalResponseInput,
    @Headers('idempotency-key') key: string, @Headers('x-request-id') requestId?: string,
  ) { return this.records.withdrawalRespond({ actor, caseId: id.toLowerCase(), input, key, requestId, commandName: 'CASE_WITHDRAWAL_RESPONDED' }, input); }
}

@Controller('admin/after-sales')
@Roles('OPERATIONS', 'SUPER_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminAfterSalesController {
  constructor(
    @Inject(AfterSalesService) private readonly cases: AfterSalesService,
    @Inject(CaseRecordsService) private readonly records: CaseRecordsService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: AuthenticatedRequest, @Query(new ZodValidationPipe(CaseListQuerySchema)) query: CaseListQuery) {
    return this.cases.adminList(requireOperatorSession(request), query);
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  detail(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.cases.adminDetail(requireOperatorSession(request), id.toLowerCase());
  }
  @Post(':id/request-evidence')
  @HttpCode(200)
  requestEvidence(
    @Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(CaseEvidenceRequestSchema)) input: CaseEvidenceRequestInput,
    @Headers('idempotency-key') key: string, @Headers('x-request-id') requestId?: string,
  ) {
    assertOperatorOrigin(request);
    const operatorSession = requireOperatorSession(request);
    return this.records.requestEvidence({ actor: operatorSession.actor, operatorSession, caseId: id.toLowerCase(), input, key, requestId, commandName: 'CASE_EVIDENCE_REQUESTED' }, input);
  }
  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(CaseRejectSchema)) input: CaseRejectInput,
    @Headers('idempotency-key') key: string, @Headers('x-request-id') requestId?: string,
  ) {
    assertOperatorOrigin(request);
    const operatorSession = requireOperatorSession(request);
    return this.records.reject({ actor: operatorSession.actor, operatorSession, caseId: id.toLowerCase(), input, key, requestId, commandName: 'CASE_REJECTED' }, input);
  }
}
