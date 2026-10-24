import { Body, Controller, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ReturnSimulationService, ReturnSimulationSchema, type ReturnSimulationInput } from './return-simulation.service.js';

@Controller('after-sales/:id/returns')
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class TestingReturnsController {
  constructor(@Inject(ReturnSimulationService) private readonly simulation: ReturnSimulationService) {}

  @Post('simulated-progress') @HttpCode(200)
  simulate(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(ReturnSimulationSchema)) input: ReturnSimulationInput, @Headers('idempotency-key') key: string, @Res({ passthrough: true }) res: Response) {
    res.set('Cache-Control', 'no-store');
    return this.simulation.progress({ actor, caseId: id.toLowerCase(), key }, input);
  }
}
