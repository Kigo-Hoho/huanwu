import { OrderCommandSchema, ProposalIdempotencyKeySchema } from '@barter/contracts';
import { BadRequestException, Body, Controller, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PaymentsService } from '../payments/payments.service.js';

@Controller('testing/payments')
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class TestingIntegrationsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}
  @Post(':intentId/complete')
  @HttpCode(200)
  complete(@CurrentUser() actor: AuthenticatedUser, @Param('intentId', new ParseUUIDPipe()) intentId: string, @Body(new ZodValidationPipe(OrderCommandSchema)) input: unknown, @Headers('idempotency-key') key: string | undefined, @Headers('x-request-id') requestId: string | undefined) {
    const parsed = ProposalIdempotencyKeySchema.safeParse(key);
    if (!parsed.success) throw new BadRequestException('A valid Idempotency-Key is required');
    return this.payments.completeSimulated(actor, intentId.toLowerCase(), OrderCommandSchema.parse(input), parsed.data, requestId);
  }
}
