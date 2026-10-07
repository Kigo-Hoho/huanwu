import { OrderCommandSchema, ProposalIdempotencyKeySchema } from '@barter/contracts';
import { BadRequestException, Body, Controller, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ShipmentsService } from '../logistics/shipments.service.js';
const schema = OrderCommandSchema.extend({ progress: z.enum(['COLLECTED', 'DELIVERED', 'EXCEPTION']) }).strict();
@Controller('testing/shipments')
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class TestingLogisticsController {
  constructor(@Inject(ShipmentsService) private readonly shipments: ShipmentsService) {}
  @Post(':shipmentId/progress') @HttpCode(200)
  progress(@CurrentUser() actor: AuthenticatedUser, @Param('shipmentId', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(schema)) input: z.infer<typeof schema>, @Headers('idempotency-key') key: string | undefined, @Headers('x-request-id') requestId: string | undefined) {
    const parsed = ProposalIdempotencyKeySchema.safeParse(key); if (!parsed.success) throw new BadRequestException('A valid Idempotency-Key is required');
    return this.shipments.progressSimulated(actor, id.toLowerCase(), input, parsed.data, requestId);
  }
}
