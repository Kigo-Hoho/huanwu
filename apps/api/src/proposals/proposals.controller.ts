import { AcceptProposalSchema, CounterProposalSchema, CreateProposalSchema, ProposalIdempotencyKeySchema } from '@barter/contracts';
import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ProposalsService } from './proposals.service.js';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CUSTOMER')
export class ProposalsController {
  constructor(@Inject(ProposalsService) private readonly proposals: ProposalsService) {}

  @Post('proposals')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateProposalSchema)) body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    const parsedKey = ProposalIdempotencyKeySchema.safeParse(key);
    if (!parsedKey.success) throw new BadRequestException('A valid Idempotency-Key is required');
    return this.proposals.create(user.id, CreateProposalSchema.parse(body), parsedKey.data, requestId);
  }

  @Get('me/proposals')
  list(@CurrentUser() user: AuthenticatedUser, @Query('direction') direction: unknown) {
    if (direction !== 'sent' && direction !== 'received') throw new BadRequestException('direction must be sent or received');
    return this.proposals.list(user.id, direction);
  }

  @Post('proposals/:id/counter')
  @HttpCode(200)
  counter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(CounterProposalSchema)) body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    return this.proposals.command(user.id, id.toLowerCase(), 'counter', CounterProposalSchema.parse(body), this.key(key), requestId);
  }

  @Post('proposals/:id/accept')
  @HttpCode(200)
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(AcceptProposalSchema)) body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    return this.proposals.command(user.id, id.toLowerCase(), 'accept', AcceptProposalSchema.parse(body), this.key(key), requestId);
  }

  @Post('proposals/:id/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(AcceptProposalSchema)) body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    return this.proposals.command(user.id, id.toLowerCase(), 'reject', AcceptProposalSchema.parse(body), this.key(key), requestId);
  }

  @Post('proposals/:id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(AcceptProposalSchema)) body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    return this.proposals.command(user.id, id.toLowerCase(), 'cancel', AcceptProposalSchema.parse(body), this.key(key), requestId);
  }

  private key(key: string | undefined): string {
    const parsed = ProposalIdempotencyKeySchema.safeParse(key);
    if (!parsed.success) throw new BadRequestException('A valid Idempotency-Key is required');
    return parsed.data;
  }

  @Get('proposals/:id')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.proposals.detail(user.id, id);
  }
}
