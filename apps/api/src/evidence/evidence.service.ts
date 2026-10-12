import { randomUUID } from 'node:crypto';
import { EvidenceSubmitSchema, ReportEvidenceSubmitSchema, RiskCommandResultSchema, type CaseCommandResult, type EvidenceImageMetadata, type ReportEvidenceSubmitInput, type RiskCommandResult } from '@barter/contracts';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CaseCommandsService, assertCaseKey, caseTransaction } from '../after-sales/case-commands.service.js';
import { CaseRecordsService } from '../after-sales/case-records.service.js';
import { assertCaseOperator, assertCurrentCustomer } from '../after-sales/case-policy.js';
import type { CaseCommandContext, CaseTx } from '../after-sales/case.types.js';
import { PrismaService } from '../database/prisma.service.js';
import type { CaseEvidence, Prisma, RiskReport } from '../generated/prisma/client.js';
import { canonicalHash, type OperatorSessionContext } from '../operator-security/operator-action.types.js';
import { OperatorSessionService } from '../operator-security/operator-session.service.js';
import { EvidenceImageValidator } from './evidence-image-validator.js';
import { EVIDENCE_STORAGE_PORT, type EvidenceStoragePort, type EvidenceUpload, type OwnedEvidenceObject } from './evidence-storage.port.js';

export type EvidenceActor = AuthenticatedUser | OperatorSessionContext;
export const REPORT_EVIDENCE_AUTHORIZATION = Symbol('ReportEvidenceAuthorization');
// Task7 connects its report workflows to this narrow authorization boundary.
// The default implementation reads real persisted reports; there is no public
// fixture endpoint or user-provided ownership assertion.
export interface ReportEvidenceAuthorizationPort {
  assertAuthor(tx: CaseTx, actor: AuthenticatedUser, reportId: string): Promise<RiskReport>;
  assertReader(tx: CaseTx, actor: EvidenceActor, reportId: string): Promise<void>;
}
@Injectable()
export class ReportEvidenceAuthorization implements ReportEvidenceAuthorizationPort {
  constructor(@Inject(OperatorSessionService) private readonly sessions: OperatorSessionService) {}
  async assertAuthor(tx: CaseTx, actor: AuthenticatedUser, reportId: string): Promise<RiskReport> {
    await assertCurrentCustomer(tx, actor);
    const report = await tx.riskReport.findUnique({ where: { id: reportId } });
    if (!report || report.reporterId !== actor.id) throw missingEvidence();
    return report;
  }
  async assertReader(tx: CaseTx, actor: EvidenceActor, reportId: string): Promise<void> {
    if ('sessionId' in actor) {
      await this.sessions.assertCurrent(tx, actor, 'MOBILE_LIMITED');
      if (!actor.actor.roles.some(role => ['REVIEWER', 'SUPER_ADMIN'].includes(role))) throw new ForbiddenException('Risk processing permission required');
      if (!await tx.riskReport.findUnique({ where: { id: reportId }, select: { id: true } })) throw missingEvidence();
    } else await this.assertAuthor(tx, actor, reportId);
  }
}
function missingEvidence() { return new NotFoundException('Evidence was not found'); }
@Injectable()
export class EvidenceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CaseCommandsService) private readonly commands: CaseCommandsService,
    @Inject(CaseRecordsService) private readonly records: CaseRecordsService,
    @Inject(EvidenceImageValidator) private readonly validator: EvidenceImageValidator,
    @Inject(EVIDENCE_STORAGE_PORT) private readonly storage: EvidenceStoragePort,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OperatorSessionService) private readonly sessions: OperatorSessionService,
    @Inject(REPORT_EVIDENCE_AUTHORIZATION) private readonly reports: ReportEvidenceAuthorizationPort,
  ) {}
  async appendCase(context: CaseCommandContext, description: string, files: EvidenceUpload[]): Promise<CaseCommandResult> {
    const input = parseInput(EvidenceSubmitSchema.safeParse({ ...context.input, description }));
    assertCaseKey(context.key);
    return this.withStored(files, async images => {
      // Actual file digests and their upload sequence participate in replay.
      const commandInput = { ...input, files: images.map(image => image.metadata) };
      return this.commands.run({ ...context, commandName: 'CASE_EVIDENCE_APPENDED', input: commandInput }, async ctx => {
        await this.assertCount(ctx.tx, { caseId: ctx.case.id, uploaderId: ctx.actor!.id }, images.length);
        const ids = [];
        for (const image of images) {
          const row = await ctx.tx.caseEvidence.create({ data: { caseId: ctx.case.id, uploaderId: ctx.actor!.id, description: input.description, ...image.metadata, originalKey: image.original.key, displayKey: image.display.key, createdAt: ctx.now } });
          ids.push(row.id);
        }
        await this.records.recordEvidenceInTransaction(ctx, input.description, ids);
      });
    });
  }
  async appendReport(actor: AuthenticatedUser, reportId: string, input: ReportEvidenceSubmitInput, files: EvidenceUpload[], key: string): Promise<RiskCommandResult> {
    const normalized = parseInput(ReportEvidenceSubmitSchema.safeParse(input));
    assertCaseKey(key);
    return this.withStored(files, async images => {
      const identity = { actorId: actor.id, commandName: 'REPORT_EVIDENCE_APPENDED', key };
      const requestHash = canonicalHash({ reportId, input: normalized, files: images.map(image => image.metadata) });
      return caseTransaction(this.prisma, async tx => {
        await this.reports.assertAuthor(tx, actor, reportId);
        await tx.$queryRaw`SELECT id FROM "RiskReport" WHERE id = ${reportId}::uuid FOR UPDATE`;
        // Permission and resource association are checked again after locking.
        const report = await this.reports.assertAuthor(tx, actor, reportId);
        const previous = await tx.idempotencyRecord.findUnique({ where: { actorId_commandName_key: identity } });
        if (previous) {
          if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'Idempotency key was used with different content' });
          return RiskCommandResultSchema.parse(previous.response);
        }
        if (report.version !== normalized.expectedVersion) throw new ConflictException('Report has changed');
        if (!['OPEN', 'INVESTIGATING'].includes(report.status)) throw new ConflictException('Report is closed');
        await this.assertCount(tx, { reportId, uploaderId: actor.id }, images.length);
        for (const image of images) await tx.caseEvidence.create({ data: { reportId, uploaderId: actor.id, description: normalized.description, ...image.metadata, originalKey: image.original.key, displayKey: image.display.key } });
        const updated = await tx.riskReport.update({ where: { id: reportId }, data: { version: { increment: 1 } } });
        const result = RiskCommandResultSchema.parse({ resourceId: reportId, version: updated.version });
        await tx.riskRecord.create({ data: { reportId, actorId: actor.id, targetType: report.targetType, targetId: report.targetId, action: identity.commandName, reason: normalized.description, details: { count: images.length } } });
        await this.audit.record(tx, { actorId: actor.id, action: identity.commandName, entityType: 'RiskReport', entityId: reportId, after: result });
        await tx.idempotencyRecord.create({ data: { ...identity, requestHash, response: result } });
        return result;
      });
    });
  }
  async read(actor: EvidenceActor, evidenceId: string, variant: 'preview' | 'original'): Promise<{ bytes: Buffer; contentType: string }> {
    if (!['preview', 'original'].includes(variant)) throw new BadRequestException('Invalid evidence variant');
    return this.prisma.$transaction(async tx => {
      const evidence = await tx.caseEvidence.findUnique({ where: { id: evidenceId } });
      if (!evidence) throw missingEvidence();
      await this.authorizeRead(tx, actor, evidence);
      const bytes = await this.storage.read(variant === 'original' ? evidence.originalKey : evidence.displayKey);
      if (variant === 'original') await this.audit.record(tx, { actorId: 'sessionId' in actor ? actor.actor.id : actor.id, action: 'EVIDENCE_ORIGINAL_ACCESSED', entityType: 'CaseEvidence', entityId: evidence.id, after: { variant: 'original' } });
      return { bytes, contentType: variant === 'original' ? evidence.mimeType : 'image/webp' };
    });
  }
  private async authorizeRead(tx: CaseTx, actor: EvidenceActor, evidence: CaseEvidence): Promise<void> {
    if (evidence.reportId) return this.reports.assertReader(tx, actor, evidence.reportId);
    if ('sessionId' in actor) {
      await this.sessions.assertCurrent(tx, actor, 'MOBILE_LIMITED');
      assertCaseOperator(actor.actor);
    } else {
      await assertCurrentCustomer(tx, actor);
      const value = await tx.afterSalesCase.findUnique({ where: { id: evidence.caseId! }, select: { order: { select: { initiatorId: true, recipientId: true } } } });
      if (!value || ![value.order.initiatorId, value.order.recipientId].includes(actor.id)) throw missingEvidence();
    }
  }
  private async assertCount(tx: CaseTx, where: Prisma.CaseEvidenceWhereInput, batchCount: number) {
    if ((await tx.caseEvidence.count({ where })) + batchCount > 30) throw new ConflictException({ code: 'EVIDENCE_LIMIT_EXCEEDED', message: 'A participant may submit at most thirty images per case or report' });
  }
  private async withStored<T>(files: EvidenceUpload[], use: (images: StoredImage[]) => Promise<T>): Promise<T> {
    if (!Array.isArray(files) || files.length < 1 || files.length > 9) throw new BadRequestException('Evidence requires one to nine images');
    const objects: OwnedEvidenceObject[] = [];
    const images: StoredImage[] = [];
    const owner = randomUUID();
    try {
      // Decode all files before persisting any object. Saves remain outside the
      // metadata transaction; only this upload's owned objects can be cleaned.
      const validated = [];
      for (const file of files) validated.push(await this.validator.validate(file));
      for (const [index, image] of validated.entries()) {
        const original = await this.storage.save(owner, files[index].bytes); objects.push(original);
        const display = await this.storage.save(owner, image.preview); objects.push(display);
        images.push({ metadata: image.metadata, original, display });
      }
      return await use(images);
    } finally { await this.cleanupOwned(objects); }
  }
  // A bounded cleanup task, also used after replay. Never enumerate a storage
  // directory or remove referenced evidence (including uncertain DB commits).
  async cleanupOwned(objects: OwnedEvidenceObject[]): Promise<void> {
    if (objects.length > 18) throw new BadRequestException('Cleanup exceeds one upload ownership scope');
    if (!objects.length) return;
    if (new Set(objects.map(object => object.owner)).size !== 1) throw new BadRequestException('Cleanup must belong to one upload owner');
    const keys = objects.map(object => object.key);
    const rows = await this.prisma.caseEvidence.findMany({ where: { OR: [{ originalKey: { in: keys } }, { displayKey: { in: keys } }] }, select: { originalKey: true, displayKey: true } });
    const referenced = new Set(rows.flatMap(row => [row.originalKey, row.displayKey]));
    for (const object of objects) if (!referenced.has(object.key)) await this.storage.deleteOwned(object);
  }
}
type StoredImage = { metadata: EvidenceImageMetadata; original: OwnedEvidenceObject; display: OwnedEvidenceObject };
function parseInput<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new BadRequestException('Invalid evidence metadata');
  return result.data;
}
