import { OrderPaymentSchema, ProposalIdempotencyKeySchema } from '@barter/contracts';
import { BadRequestException, Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PaymentsService } from './payments.service.js';

@Controller('orders/:id/payments')
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}
  @Post()
  @HttpCode(202)
  start(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(OrderPaymentSchema)) input: unknown, @Headers('idempotency-key') key: string | undefined, @Headers('x-request-id') requestId: string | undefined) {
    const parsed = ProposalIdempotencyKeySchema.safeParse(key);
    if (!parsed.success) throw new BadRequestException('A valid Idempotency-Key is required');
    return this.payments.start(actor, id.toLowerCase(), OrderPaymentSchema.parse(input), parsed.data, requestId);
  }
  @Get(':intentId/checkout')
  @Header('Cache-Control', 'no-store')
  checkout(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Param('intentId', new ParseUUIDPipe()) intentId: string) {
    return this.payments.checkout(actor, id.toLowerCase(), intentId.toLowerCase());
  }
}
