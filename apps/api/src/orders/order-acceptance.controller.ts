import { OrderCommandSchema, OrderIssueSchema, ProposalIdempotencyKeySchema } from '@barter/contracts';
import { BadRequestException, Body, Controller, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrderAcceptanceService } from './order-acceptance.service.js';

@Controller('orders/:id')
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class OrderAcceptanceController {
  constructor(@Inject(OrderAcceptanceService) private readonly acceptance: OrderAcceptanceService) {}
  @Post('acceptance')
  @HttpCode(200)
  accept(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(OrderCommandSchema)) input: unknown, @Headers('idempotency-key') key: string | undefined, @Headers('x-request-id') requestId: string | undefined) {
    const parsed = ProposalIdempotencyKeySchema.safeParse(key);
    if (!parsed.success) throw new BadRequestException('A valid Idempotency-Key is required');
    return this.acceptance.accept(actor, id.toLowerCase(), OrderCommandSchema.parse(input), parsed.data, requestId);
  }
  @Post('issue')
  @HttpCode(200)
  issue(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(OrderIssueSchema)) input: unknown, @Headers('idempotency-key') key: string | undefined, @Headers('x-request-id') requestId: string | undefined) {
    const parsed = ProposalIdempotencyKeySchema.safeParse(key);
    if (!parsed.success) throw new BadRequestException('A valid Idempotency-Key is required');
    return this.acceptance.issue(actor, id.toLowerCase(), OrderIssueSchema.parse(input), parsed.data, requestId);
  }
}
