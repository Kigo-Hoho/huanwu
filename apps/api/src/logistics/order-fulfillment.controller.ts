import { OrderCommandSchema, OrderShipmentSchema, ProposalIdempotencyKeySchema } from '@barter/contracts';
import { BadRequestException, Body, Controller, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrderHandoverService } from '../orders/order-handover.service.js';
import { ShipmentsService } from './shipments.service.js';
const commandKey = (key: string | undefined) => { const parsed = ProposalIdempotencyKeySchema.safeParse(key); if (!parsed.success) throw new BadRequestException('A valid Idempotency-Key is required'); return parsed.data; };
@Controller('orders')
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class OrderFulfillmentController {
  constructor(@Inject(ShipmentsService) private readonly shipments: ShipmentsService, @Inject(OrderHandoverService) private readonly handover: OrderHandoverService) {}
  @Post(':id/shipments') @HttpCode(200)
  submit(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(OrderShipmentSchema)) input: unknown, @Headers('idempotency-key') key: string | undefined, @Headers('x-request-id') requestId: string | undefined) { return this.shipments.submit(actor, id.toLowerCase(), OrderShipmentSchema.parse(input), commandKey(key), requestId); }
  @Post(':id/handover') @HttpCode(200)
  confirm(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(OrderCommandSchema)) input: unknown, @Headers('idempotency-key') key: string | undefined, @Headers('x-request-id') requestId: string | undefined) { return this.handover.confirm(actor, id.toLowerCase(), OrderCommandSchema.parse(input), commandKey(key), requestId); }
}
