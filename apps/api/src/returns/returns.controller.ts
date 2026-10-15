import { ReturnAddressSchema, ReturnShipmentSchema, ReturnHandoverSchema, ReturnConfirmSchema, type ReturnAddressInput, type ReturnShipmentInput, type ReturnHandoverInput, type ReturnConfirmInput } from '@barter/contracts';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ReturnAddressService } from './return-address.service.js';
import { ReturnCommandsService } from './return-commands.service.js';
import { ReturnSimulationService, ReturnSimulationSchema, type ReturnSimulationInput } from './return-simulation.service.js';

@Controller('after-sales/:id')
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class ReturnsController {
  constructor(@Inject(ReturnAddressService) private readonly addresses: ReturnAddressService, @Inject(ReturnCommandsService) private readonly commands: ReturnCommandsService, @Inject(ReturnSimulationService) private readonly simulation: ReturnSimulationService) {}
  @Post('returns/simulated-progress') @HttpCode(200)
  simulate(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(ReturnSimulationSchema)) input: ReturnSimulationInput, @Headers('idempotency-key') key: string, @Res({ passthrough: true }) res: Response) { res.set('Cache-Control', 'no-store'); return this.simulation.progress({ actor, caseId: id.toLowerCase(), key }, input); }
  @Get('returns')
  list(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.commands.list(actor, id.toLowerCase()); }
  @Post('return-address') @HttpCode(200)
  save(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(ReturnAddressSchema)) input: ReturnAddressInput, @Headers('idempotency-key') key: string, @Headers('x-request-id') requestId?: string) { return this.addresses.save(actor, id.toLowerCase(), input, key, requestId); }
  @Get('return-address')
  get(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Query('side') side: 'self'|'outgoing', @Res({ passthrough: true }) res: Response, @Headers('x-request-id') requestId?: string) { res.set('Cache-Control', 'no-store'); return this.addresses.get(actor, id.toLowerCase(), side, requestId); }
  @Post('returns/shipment') @HttpCode(200)
  shipment(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(ReturnShipmentSchema)) input: ReturnShipmentInput, @Headers('idempotency-key') key: string, @Headers('x-request-id') requestId?: string) { return this.commands.registerShipment({ actor, caseId: id.toLowerCase(), key, requestId }, input); }
  @Post('returns/handover') @HttpCode(200)
  handover(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(ReturnHandoverSchema)) input: ReturnHandoverInput, @Headers('idempotency-key') key: string, @Headers('x-request-id') requestId?: string) { return this.commands.handBack({ actor, caseId: id.toLowerCase(), key, requestId }, input); }
  @Post('returns/confirmation') @HttpCode(200)
  confirmation(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(ReturnConfirmSchema)) input: ReturnConfirmInput, @Headers('idempotency-key') key: string, @Headers('x-request-id') requestId?: string) { return this.commands.confirmReceived({ actor, caseId: id.toLowerCase(), key, requestId }, input); }
}
