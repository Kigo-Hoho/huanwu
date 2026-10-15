import { RiskCommandResultSchema, RiskReportDetailSchema, RiskReportListViewSchema, RiskReportViewSchema, RiskTaskListViewSchema, RiskTaskViewSchema, TradingRestrictionViewSchema, OperatorSecurityListInputSchema, type CreateRiskReportInput, type RiskCommandResult, type RiskReportCommand, type ConcludeRiskReportInput } from '@barter/contracts';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { assertCurrentCustomer } from '../after-sales/case-policy.js';
import { assertCaseKey, caseTransaction } from '../after-sales/case-commands.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma, RiskReport, CaseEvidence } from '../generated/prisma/client.js';
import { OperatorSessionService } from '../operator-security/operator-session.service.js';
import { canonicalHash, type OperatorSessionContext } from '../operator-security/operator-action.types.js';
import { TradingRestrictionsService } from './trading-restrictions.service.js';

export function missingReport() { return new NotFoundException('Report was not found'); }
export function assertRiskRole(context: OperatorSessionContext) {
  if (!context.actor.roles.some(role => ['REVIEWER', 'SUPER_ADMIN'].includes(role)) || context.actor.roles.includes('CUSTOMER')) throw new ForbiddenException('Risk processing permission required');
}
export async function replayRisk(tx: Prisma.TransactionClient, identity: { actorId: string; commandName: string; key: string }, requestHash: string): Promise<RiskCommandResult | null> {
  const previous = await tx.idempotencyRecord.findUnique({ where: { actorId_commandName_key: identity } });
  if (!previous) return null;
  if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'Idempotency key was used with different content' });
  return RiskCommandResultSchema.parse(previous.response);
}
function summary(value: RiskReport) {
  const { id, targetType, targetId, reason, description, status, version, createdAt, updatedAt } = value;
  return RiskReportViewSchema.parse({ id, targetType, targetId, reason, description, status, version, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() });
}
function evidenceView(value: CaseEvidence) {
  const { id, description, mimeType, bytes, width, height, sha256, createdAt } = value;
  return { id, description, mimeType, bytes, width, height, sha256, createdAt: createdAt.toISOString() };
}
function pageInput(query: unknown) {
  const parsed = OperatorSecurityListInputSchema.safeParse(query);
  if (!parsed.success) throw new BadRequestException('Invalid risk list cursor or limit');
  const { cursor, limit } = parsed.data;
  const [time, id] = cursor?.split('~') ?? [];
  return { limit, after: cursor ? { OR: [{ createdAt: { lt: new Date(time) } }, { createdAt: new Date(time), id: { lt: id } }] } : {} };
}
function nextCursor<T extends { createdAt: Date; id: string }>(rows: T[], limit: number) {
  const last = rows[limit - 1];
  return rows.length > limit && last ? `${last.createdAt.toISOString()}~${last.id}` : null;
}
@Injectable()
export class RiskReportService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OperatorSessionService) private readonly sessions: OperatorSessionService,
    @Inject(TradingRestrictionsService) private readonly restrictions: TradingRestrictionsService) {}

  async create(actor: AuthenticatedUser, input: CreateRiskReportInput, key: string): Promise<RiskCommandResult> {
    assertCaseKey(key);
    const identity = { actorId: actor.id, commandName: 'RISK_REPORT_CREATED', key };
    const requestHash = canonicalHash(input);
    return caseTransaction(this.prisma, async tx => {
      await assertCurrentCustomer(tx, actor);
      const previous = await replayRisk(tx, identity, requestHash);
      if (previous) return previous;
      await this.assertTarget(tx, actor.id, input);
      const existing = await tx.riskReport.findFirst({ where: { reporterId: actor.id, targetType: input.targetType, targetId: input.targetId, reason: input.reason, status: { in: ['OPEN', 'INVESTIGATING'] } } });
      const value = existing ?? await tx.riskReport.create({ data: { reporterId: actor.id, targetType: input.targetType, targetId: input.targetId, reason: input.reason, description: input.description } });
      const result = { resourceId: value.id, version: value.version };
      if (!existing) await this.audit.record(tx, { actorId: actor.id, action: identity.commandName, entityType: 'RiskReport', entityId: value.id, after: result });
      await tx.idempotencyRecord.create({ data: { ...identity, requestHash, response: result } });
      return result;
    });
  }
  private async assertTarget(tx: Prisma.TransactionClient, actorId: string, input: CreateRiskReportInput) {
    let version: number;
    if (input.targetType === 'ITEM') {
      const located = await tx.item.findUnique({ where: { id: input.targetId }, select: { ownerId: true } });
      if (!located) throw missingReport();
      await this.restrictions.lock(tx, [located.ownerId]);
      await tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${input.targetId}::uuid FOR UPDATE`;
      const item = await tx.item.findFirst({ where: { id: input.targetId, status: 'ACTIVE', owner: { OR: [{ tradingRestriction: null }, { tradingRestriction: { status: 'CLEAR' } }] } } });
      if (!item) throw missingReport();
      version = item.version;
    } else {
      const orderId = input.targetType === 'ORDER' ? input.targetId : (await tx.shipment.findUnique({ where: { id: input.targetId }, select: { orderId: true } }))?.orderId;
      if (!orderId) throw missingReport();
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order || ![order.initiatorId, order.recipientId].includes(actorId)) throw missingReport();
      version = order.version;
    }
    if (version !== input.expectedTargetVersion) throw new ConflictException('Report target has changed');
  }
  async list(actor: AuthenticatedUser | OperatorSessionContext, query: unknown) {
    const { limit, after } = pageInput(query);
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, actor);
      const rows = await tx.riskReport.findMany({ where: { ...after, ...('sessionId' in actor ? {} : { reporterId: actor.id }) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
      return RiskReportListViewSchema.parse({ items: rows.slice(0, limit).map(summary), nextCursor: nextCursor(rows, limit) });
    });
  }
  async detail(actor: AuthenticatedUser | OperatorSessionContext, id: string) {
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, actor);
      const value = await tx.riskReport.findUnique({ where: { id }, include: { evidence: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, records: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
      if (!value || (!('sessionId' in actor) && value.reporterId !== actor.id)) throw missingReport();
      return RiskReportDetailSchema.parse({ ...summary(value), evidence: value.evidence.map(evidenceView), records: value.records.map(({ id, action, reason, createdAt }) => ({ id, action, reason, createdAt: createdAt.toISOString() })) });
    }, { isolationLevel: 'RepeatableRead' });
  }
  async process(context: OperatorSessionContext, id: string, action: 'claim' | 'request-evidence' | 'conclude', input: RiskReportCommand | ConcludeRiskReportInput, key: string): Promise<RiskCommandResult> {
    assertCaseKey(key);
    const identity = { actorId: context.actor.id, commandName: `REPORT_${action.toUpperCase().replace('-', '_')}`, key };
    const requestHash = canonicalHash({ id, input });
    return caseTransaction(this.prisma, async tx => {
      await this.authorize(tx, context);
      await tx.$queryRaw`SELECT id FROM "RiskReport" WHERE id = ${id}::uuid FOR UPDATE`;
      const value = await tx.riskReport.findUnique({ where: { id } });
      if (!value) throw missingReport();
      const previous = await replayRisk(tx, identity, requestHash);
      if (previous) return previous;
      if (value.version !== input.expectedVersion) throw new ConflictException('Report has changed');
      if (!['OPEN', 'INVESTIGATING'].includes(value.status)) throw new ConflictException('Report is closed');
      const claims = await tx.riskRecord.findMany({ where: { reportId: id, action: 'REPORT_CLAIM' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 });
      if (claims[0] && claims[0].actorId !== context.actor.id) throw new ConflictException('Report is claimed by another operator');
      if (action !== 'claim' && !claims[0]) throw new ConflictException('Claim report before processing');
      const status = action === 'conclude' ? (input as ConcludeRiskReportInput).conclusion : 'INVESTIGATING';
      if (status === 'ACTIONED' && value.reason === 'FALSE_SHIPMENT' && !await tx.caseEvidence.count({ where: { reportId: id } })) throw new ConflictException('A false-shipment conclusion requires supporting evidence');
      const updated = await tx.riskReport.update({ where: { id }, data: { status, version: { increment: 1 } } });
      await tx.riskRecord.create({ data: { reportId: id, actorId: context.actor.id, targetType: value.targetType, targetId: value.targetId, action: identity.commandName, reason: input.reason, details: { status } } });
      const result = { resourceId: id, version: updated.version };
      await this.audit.record(tx, { actorId: context.actor.id, action: identity.commandName, entityType: 'RiskReport', entityId: id, reason: input.reason, before: { status: value.status, version: value.version }, after: { status, version: updated.version } });
      await tx.idempotencyRecord.create({ data: { ...identity, requestHash, response: result } });
      return result;
    });
  }
  async tasks(context: OperatorSessionContext, query: unknown, id?: string) {
    const { limit, after } = pageInput(query);
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, context);
      const rows = await tx.riskTask.findMany({ where: { ...after, ...(id ? { id } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: id ? 1 : limit + 1 });
      const map = (value: typeof rows[number]) => { const { id, orderId, caseId, reportId, kind, description, status, createdAt, updatedAt } = value; return { id, orderId, caseId, reportId, kind, description, status, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() }; };
      if (id) { if (!rows[0]) throw missingReport(); return RiskTaskViewSchema.parse(map(rows[0])); }
      return RiskTaskListViewSchema.parse({ items: rows.slice(0, limit).map(map), nextCursor: nextCursor(rows, limit) });
    });
  }
  async restriction(context: OperatorSessionContext, id: string) {
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, context);
      if (!await tx.user.findUnique({ where: { id }, select: { id: true } })) throw new NotFoundException('User was not found');
      const value = await tx.tradingRestriction.findUnique({ where: { userId: id } });
      return TradingRestrictionViewSchema.parse({ status: value?.status ?? 'CLEAR', version: value?.version ?? 1, reason: value?.reason ?? null });
    });
  }
  private async authorize(tx: Prisma.TransactionClient, actor: AuthenticatedUser | OperatorSessionContext) {
    if ('sessionId' in actor) { await this.sessions.assertCurrent(tx, actor, 'MOBILE_LIMITED'); assertRiskRole(actor); }
    else await assertCurrentCustomer(tx, actor);
  }
}
