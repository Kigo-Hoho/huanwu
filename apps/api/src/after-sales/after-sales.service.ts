import { AdminCaseDetailViewSchema, AdminCaseListViewSchema, CaseCommandResultSchema, CaseDetailViewSchema, CaseListViewSchema, type CaseCommandResult, type CaseListQuery, type CreateCaseInput } from '@barter/contracts';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AfterSalesCase, Prisma } from '../generated/prisma/client.js';
import { canonicalHash, type OperatorSessionContext } from '../operator-security/operator-action.types.js';
import { OperatorSessionService } from '../operator-security/operator-session.service.js';
import { assertOrderParticipant } from '../orders/order-commands.service.js';
import { OrderHoldService } from '../orders/order-hold.service.js';
import { readOrder } from '../orders/order-reader.js';
import { assertCaseKey, caseTransaction, replayCaseCommand } from './case-commands.service.js';
import { mapAdminCase, mapAdminCaseEvidence, mapAdminCaseRecord, mapCase, mapCaseEvidence, mapCaseRecord } from './case.mapper.js';
import { assertCaseEligibility, assertCaseOperator, assertCaseParticipant, assertCurrentCustomer } from './case-policy.js';
import { readCase } from './case-reader.js';

const cursorSchema = z.strictObject({ createdAt: z.iso.datetime(), id: z.string().uuid().toLowerCase() });
function pageBoundary(cursor?: string): Prisma.AfterSalesCaseWhereInput {
  if (!cursor) return {};
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== cursor) throw new Error('Invalid encoding');
    const value = cursorSchema.parse(JSON.parse(decoded));
    const createdAt = new Date(value.createdAt);
    return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: value.id } }] };
  } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Invalid after-sales cursor' }); }
}
function casePredecessor(history: AfterSalesCase[], associations: { caseId: string; details: Prisma.JsonValue | null }[]): AfterSalesCase | undefined {
  if (history.length === 0) return undefined;
  const invalid = () => {
    throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'Ambiguous closed-case history requires manual verification', manualVerificationRequired: true });
  };
  const cases = new Map(history.map(value => [value.id, value]));
  if (new Set(history.map(value => value.rootDisputeId)).size !== 1) invalid();
  const parents = new Map<string, string>();
  const opened = new Set<string>();
  for (const record of associations) {
    if (opened.has(record.caseId)) invalid();
    opened.add(record.caseId);
    if (record.details === null) continue;
    if (typeof record.details !== 'object' || Array.isArray(record.details)) invalid();
    const details = record.details as Prisma.JsonObject;
    if (!Object.hasOwn(details, 'previousCaseId')) continue;
    const id = z.string().uuid().toLowerCase().safeParse(details.previousCaseId);
    if (!id.success || !cases.has(id.data)) invalid();
    const parentId = id.data!;
    if (Object.hasOwn(details, 'previousOutcome') && details.previousOutcome !== cases.get(parentId)!.status) invalid();
    parents.set(record.caseId, parentId);
  }
  const superseded = new Set(parents.values());
  const tails = history.filter(value => !superseded.has(value.id));
  if (tails.length !== 1) invalid();
  const visited = new Set<string>();
  let id: string | undefined = tails[0]!.id;
  while (id !== undefined) {
    if (visited.has(id)) invalid();
    visited.add(id);
    id = parents.get(id);
  }
  // One apparent tail is insufficient if a disconnected cycle/chain is omitted.
  if (visited.size !== history.length) invalid();
  return tails[0];
}
@Injectable()
export class AfterSalesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OrderHoldService) private readonly hold: OrderHoldService,
    @Inject(OperatorSessionService) private readonly sessions: OperatorSessionService,
  ) {}
  async open(actor: AuthenticatedUser, orderId: string, input: CreateCaseInput, key: string, requestId?: string): Promise<CaseCommandResult> {
    assertCaseKey(key);
    const identity = { actorId: actor.id, commandName: 'OPEN_AFTER_SALES', key };
    const requestHash = canonicalHash({ id: orderId, input });
    return caseTransaction(this.prisma, async tx => {
      await assertCurrentCustomer(tx, actor);
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await readOrder(tx, orderId);
      assertOrderParticipant(order, actor.id);
      const replay = await replayCaseCommand(tx, identity, requestHash);
      if (replay) return replay;
      const active = await tx.afterSalesCase.findFirst({ where: { orderId, closedAt: null } });
      if (active) throw new ConflictException({ code: 'AFTER_SALES_ALREADY_OPEN', message: 'An open case already exists; add a response to that case' });
      if (order.version !== input.expectedOrderVersion) throw new ConflictException({ code: 'ORDER_VERSION_CONFLICT', message: 'Order has changed' });
      const now = this.clock.now();
      await assertCaseEligibility(tx, order, now);
      const history = await tx.afterSalesCase.findMany({ where: { orderId } });
      const associations = await tx.caseRecord.findMany({ where: { case: { orderId }, kind: 'OPENED' }, select: { caseId: true, details: true } });
      const latest = casePredecessor(history, associations);
      if (input.previousCaseId && latest?.id !== input.previousCaseId) throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'Successor must reference the latest closed case on this order' });
      const value = await tx.afterSalesCase.create({ data: { orderId, applicantId: actor.id, reason: input.reason, ...(latest ? { rootDisputeId: latest.rootDisputeId } : {}), createdAt: now } });
      await tx.caseRecord.create({ data: { caseId: value.id, actorId: actor.id, kind: 'OPENED', description: input.reason, details: latest ? { previousCaseId: latest.id, previousOutcome: latest.status } : undefined, createdAt: now } });
      await this.hold.enter(tx, order, input.reason, now, { kind: 'CASE', sourceId: value.id });
      await tx.order.update({ where: { id: orderId }, data: { version: { increment: 1 } } });
      const result = CaseCommandResultSchema.parse({ case: mapCase(value), orderVersion: order.version + 1 });
      await this.audit.record(tx, {
        actorId: actor.id, action: 'CASE_OPENED', entityType: 'AfterSalesCase',
        entityId: value.id, requestId, after: result as unknown as Prisma.InputJsonValue,
      });
      await tx.idempotencyRecord.create({ data: { ...identity, requestHash, response: result as unknown as Prisma.InputJsonValue } });
      return result;
    });
  }
  async detail(actor: AuthenticatedUser, id: string) {
    return this.prisma.$transaction(async tx => {
      await assertCurrentCustomer(tx, actor);
      const value = await readCase(tx, id);
      const order = value ? await readOrder(tx, value.orderId) : null;
      assertCaseParticipant(order, value, actor.id);
      return CaseDetailViewSchema.parse({ ...mapCase(value), records: value.records.map(record => mapCaseRecord(record, order!)), evidence: value.evidence.map(mapCaseEvidence) });
    }, { isolationLevel: 'RepeatableRead' });
  }
  async adminDetail(context: OperatorSessionContext, id: string) {
    return this.prisma.$transaction(async tx => {
      await this.sessions.assertCurrent(tx, context, 'MOBILE_LIMITED');
      assertCaseOperator(context.actor);
      const value = await readCase(tx, id);
      const order = value ? await readOrder(tx, value.orderId) : null;
      if (!value || !order) throw new NotFoundException({ code: 'AFTER_SALES_NOT_FOUND', message: 'After-sales case was not found' });
      return AdminCaseDetailViewSchema.parse({ ...mapAdminCase(value), records: value.records.map(record => mapAdminCaseRecord(record, order)), evidence: value.evidence.map(mapAdminCaseEvidence) });
    }, { isolationLevel: 'RepeatableRead' });
  }
  async list(actor: AuthenticatedUser, query: CaseListQuery) {
    return this.listPage(actor, query);
  }
  async adminList(context: OperatorSessionContext, query: CaseListQuery) {
    return this.listPage(context.actor, query, context);
  }
  private async listPage(actor: AuthenticatedUser, query: CaseListQuery, operator?: OperatorSessionContext) {
    const after = pageBoundary(query.cursor);
    return this.prisma.$transaction(async tx => {
      if (operator) {
        await this.sessions.assertCurrent(tx, operator, 'MOBILE_LIMITED');
        assertCaseOperator(operator.actor);
      } else await assertCurrentCustomer(tx, actor);
      const rows = await tx.afterSalesCase.findMany({
        where: { AND: [after, query.status ? { status: query.status } : {}, operator ? {} : { order: { OR: [{ initiatorId: actor.id }, { recipientId: actor.id }] } }] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const nextCursor = rows.length > query.limit && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })).toString('base64url') : null;
      return operator ? AdminCaseListViewSchema.parse({ items: page.map(mapAdminCase), nextCursor }) : CaseListViewSchema.parse({ items: page.map(mapCase), nextCursor });
    });
  }
}
