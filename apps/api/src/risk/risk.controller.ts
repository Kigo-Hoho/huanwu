import { CreateRiskReportSchema, ReportEvidenceSubmitSchema, type CreateRiskReportInput } from '@barter/contracts';
import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CustomerOnlyGuard } from '../auth/customer-only.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { EvidenceService } from '../evidence/evidence.service.js';
import { RiskReportService } from './risk-report.service.js';

@Controller('reports')
@UseGuards(JwtAuthGuard, CustomerOnlyGuard)
export class RiskController {
  constructor(@Inject(RiskReportService) private readonly reports: RiskReportService, @Inject(EvidenceService) private readonly evidence: EvidenceService) {}
  @Post()
  create(@CurrentUser() actor: AuthenticatedUser, @Body(new ZodValidationPipe(CreateRiskReportSchema)) input: CreateRiskReportInput, @Headers('idempotency-key') key: string) { return this.reports.create(actor, input, key); }
  @Get()
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: unknown) { return this.reports.list(actor, query); }
  @Get(':id')
  detail(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.reports.detail(actor, id.toLowerCase()); }
  @Post(':id/evidence')
  @HttpCode(200)
  @UseInterceptors(FilesInterceptor('files', 9, { limits: { fileSize: 8388608, files: 9, fields: 2, fieldSize: 8192 } }))
  append(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @UploadedFiles() files: { buffer: Buffer; mimetype: string }[] | undefined, @Headers('idempotency-key') key: string) {
    const rawVersion = body?.expectedVersion;
    const parsed = ReportEvidenceSubmitSchema.safeParse({ ...body, expectedVersion: typeof rawVersion === 'string' && /^[1-9][0-9]*$/.test(rawVersion) ? Number(rawVersion) : rawVersion });
    if (!parsed.success) throw new BadRequestException('Invalid report evidence metadata');
    return this.evidence.appendReport(actor, id.toLowerCase(), parsed.data, (files ?? []).map(file => ({ bytes: file.buffer, contentType: file.mimetype })), key);
  }
}
