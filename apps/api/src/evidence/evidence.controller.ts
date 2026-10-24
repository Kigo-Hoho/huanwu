import { EvidenceSubmitSchema, type EvidenceSubmitInput } from '@barter/contracts';
import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { assertPureCustomer, CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { requireOperatorSession } from '../operator-security/operator-security.controller.js';
import { EvidenceService } from './evidence.service.js';
interface UploadedEvidenceFile { buffer: Buffer; mimetype: string }

@Controller()
@UseGuards(JwtAuthGuard)
export class EvidenceController {
  constructor(@Inject(EvidenceService) private readonly evidence: EvidenceService) {}
  @Post('after-sales/:id/evidence')
  @HttpCode(200)
  @UseGuards(CustomerOnlyGuard)
  @UseInterceptors(FilesInterceptor('files', 9, { limits: { fileSize: 8388608, files: 9, fields: 3, fieldSize: 8192 } }))
  appendCase(
    @CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown, @UploadedFiles() files: UploadedEvidenceFile[] | undefined,
    @Headers('idempotency-key') key: string, @Headers('x-request-id') requestId?: string,
  ) {
    const input = multipartInput(body);
    return this.evidence.appendCase({ actor, caseId: id.toLowerCase(), input: { expectedCaseVersion: input.expectedCaseVersion, expectedOrderVersion: input.expectedOrderVersion }, key, requestId, commandName: 'CASE_EVIDENCE_APPENDED' }, input.description, (files ?? []).map(file => ({ bytes: file.buffer, contentType: file.mimetype })));
  }
  @Get('evidence/:id/content')
  async content(
    @Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: Record<string, unknown>, @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    if (Object.keys(query).length !== 1 || (query.variant !== 'preview' && query.variant !== 'original')) throw new BadRequestException('Evidence variant must be preview or original');
    let actor;
    if (request.user.roles.includes('CUSTOMER')) { assertPureCustomer(request.user); actor = request.user; }
    else actor = requireOperatorSession(request);
    const stored = await this.evidence.read(actor, id.toLowerCase(), query.variant);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', stored.contentType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (query.variant === 'original') response.setHeader('Content-Disposition', 'attachment');
    return new StreamableFile(stored.bytes);
  }
}
function multipartInput(body: unknown): EvidenceSubmitInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequestException('Invalid evidence metadata');
  const value = body as Record<string, unknown>;
  const number = (input: unknown) => typeof input === 'string' && /^[1-9][0-9]*$/.test(input) ? Number(input) : input;
  const parsed = EvidenceSubmitSchema.safeParse({ ...value, expectedCaseVersion: number(value.expectedCaseVersion), expectedOrderVersion: number(value.expectedOrderVersion) });
  if (!parsed.success) throw new BadRequestException('Invalid evidence metadata');
  return parsed.data;
}
