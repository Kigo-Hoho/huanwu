import { OrderAddressSchema, OrderCommandSchema, OrderStatusSchema, ProposalIdempotencyKeySchema } from '@barter/contracts';
import { BadRequestException, Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrdersService } from './orders.service.js';
import { OrderAddressService } from './order-address.service.js';
const listSchema = z.strictObject({ cursor: z.string().optional(), status: OrderStatusSchema.optional(), limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional() });
const addressQuerySchema = z.strictObject({ side: z.enum(['self', 'outgoing']) });
@Controller()
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService, @Inject(OrderAddressService) private readonly addresses: OrderAddressService) {}
  @Post('proposals/:id/order')
  convert(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(OrderCommandSchema)) input: unknown, @Headers('idempotency-key') key: string | undefined, @Headers('x-request-id') requestId: string | undefined) {
    const parsed = ProposalIdempotencyKeySchema.safeParse(key);
    if (!parsed.success) throw new BadRequestException('A valid Idempotency-Key is required');
    return this.orders.convert(actor, id.toLowerCase(), OrderCommandSchema.parse(input), parsed.data, requestId);
  }
  @Get('orders/:id')
  detail(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.orders.detail(actor, id.toLowerCase()); }
  @Get('me/orders')
  list(@CurrentUser() actor: AuthenticatedUser, @Query(new ZodValidationPipe(listSchema)) query: z.output<typeof listSchema>) { return this.orders.list(actor, query); }
  @Post('orders/:id/address')
  @HttpCode(200)
  address(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(OrderAddressSchema)) input: unknown, @Headers('idempotency-key') key: string | undefined, @Headers('x-request-id') requestId: string | undefined) {
    const parsed = ProposalIdempotencyKeySchema.safeParse(key);
    if (!parsed.success) throw new BadRequestException('A valid Idempotency-Key is required');
    return this.addresses.save(actor, id.toLowerCase(), OrderAddressSchema.parse(input), parsed.data, requestId);
  }
  @Get('orders/:id/shipping-address')
  @Header('Cache-Control', 'no-store')
  shippingAddress(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodValidationPipe(addressQuerySchema)) query: z.output<typeof addressQuerySchema>, @Headers('x-request-id') requestId: string | undefined) { return this.addresses.get(actor, id.toLowerCase(), query, requestId); }
}
