import { Body, Controller, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ResolutionCommandSchema } from '@barter/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CompensationSimulationService } from './compensation-simulation.service.js';
@Controller('testing/compensation')
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class TestingCompensationController {
  constructor(@Inject(CompensationSimulationService) private readonly service: CompensationSimulationService) {}
  @Post(':paymentId/complete') @HttpCode(200)
  complete(@CurrentUser() actor: AuthenticatedUser, @Param('paymentId', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(ResolutionCommandSchema)) input: unknown, @Headers('idempotency-key') key: string) { return this.service.complete(actor, id, input, key); }
}
