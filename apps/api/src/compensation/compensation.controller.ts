import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ResolutionCommandSchema } from '@barter/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CompensationService } from './compensation.service.js';
@Controller('after-sales/:caseId/compensation/payments')
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class CompensationController {
  constructor(@Inject(CompensationService) private readonly service: CompensationService) {}
  @Post() @HttpCode(200)
  request(@CurrentUser() actor: AuthenticatedUser, @Param('caseId', new ParseUUIDPipe()) caseId: string, @Body(new ZodValidationPipe(ResolutionCommandSchema)) input: unknown, @Headers('idempotency-key') key: string) { return this.service.requestPayment({ actor, caseId, input: ResolutionCommandSchema.parse(input), key, commandName: 'COMPENSATION_PAYMENT_REQUESTED' }); }
  @Get(':paymentId/checkout') @Header('Cache-Control', 'no-store')
  checkout(@CurrentUser() actor: AuthenticatedUser, @Param('caseId', new ParseUUIDPipe()) caseId: string, @Param('paymentId', new ParseUUIDPipe()) paymentId: string) { return this.service.getCheckout(actor, caseId, paymentId); }
}
