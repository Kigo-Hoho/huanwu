import { RiskCommandResultSchema, type OperatorAction, type RiskActionInput, type ClearOrderRiskInput, type RiskCommandResult } from '@barter/contracts';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { assertCaseKey, caseTransaction } from '../after-sales/case-commands.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ActionGrantService } from '../operator-security/action-grant.service.js';
import { actionCapability, assertActionRole, operatorRequestHash, type OperatorActionContext } from '../operator-security/operator-action.types.js';
import { OperatorSessionService } from '../operator-security/operator-session.service.js';
import { OrderHoldService } from '../orders/order-hold.service.js';
import { readOrder } from '../orders/order-reader.js';
import { TradingRestrictionsService } from './trading-restrictions.service.js';
import { replayRisk, assertRiskRole } from './risk-report.service.js';

type Command = 'freeze' | 'unfreeze' | 'unpublish' | 'clearItem' | 'pause' | 'clearOrder';
const actions: Record<Command, OperatorAction> = { freeze: 'FREEZE_TRADING', unfreeze: 'UNFREEZE_TRADING', unpublish: 'UNPUBLISH_ITEM', clearItem: 'CLEAR_ITEM_RISK', pause: 'HOLD_ORDER', clearOrder: 'CLEAR_ORDER_RISK' };
const audits: Record<Command, string> = { freeze: 'TRADING_FROZEN', unfreeze: 'TRADING_UNFROZEN', unpublish: 'RISK_ITEM_UNPUBLISHED', clearItem: 'RISK_ITEM_CLEARED', pause: 'RISK_ORDER_PAUSED', clearOrder: 'RISK_ORDER_CLEARED' };
@Injectable()
export class RiskActionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TradingRestrictionsService) private readonly restrictions: TradingRestrictionsService,
    @Inject(OperatorSessionService) private readonly sessions: OperatorSessionService,
    @Inject(ActionGrantService) private readonly grants: ActionGrantService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrderHoldService) private readonly hold: OrderHoldService,
    @Inject(CLOCK) private readonly clock: Clock) {}
  freeze(context: OperatorActionContext, id: string, input: RiskActionInput, key: string) { return this.run(context, id, 'freeze', input, key); }
  unfreeze(context: OperatorActionContext, id: string, input: RiskActionInput, key: string) { return this.run(context, id, 'unfreeze', input, key); }
  unpublish(context: OperatorActionContext, id: string, input: RiskActionInput, key: string) { return this.run(context, id, 'unpublish', input, key); }
  pause(context: OperatorActionContext, id: string, input: RiskActionInput, key: string) { return this.run(context, id, 'pause', input, key); }
  clearItem(context: OperatorActionContext, id: string, input: RiskActionInput, key: string) { return this.run(context, id, 'clearItem', input, key); }
  clearOrder(context: OperatorActionContext, id: string, input: ClearOrderRiskInput, key: string) { return this.run(context, id, 'clearOrder', input, key); }
  private async run(context: OperatorActionContext, id: string, command: Command, input: RiskActionInput | ClearOrderRiskInput, key: string): Promise<RiskCommandResult> {
    assertCaseKey(key);
    const action = actions[command];
    const identity = { actorId: context.actor.id, commandName: audits[command], key };
    const business = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'operatorAction'));
    const requestHash = operatorRequestHash({ id, input: business });
    return caseTransaction(this.prisma, async tx => {
      await this.sessions.assertCurrent(tx, context, actionCapability(action));
      assertRiskRole(context); assertActionRole(context.actor, action);
      if (input.operatorAction.sessionId !== context.sessionId) throw new ForbiddenException('Action belongs to another session');
      const userAction = ['freeze', 'unfreeze'].includes(command);
      const itemAction = ['unpublish', 'clearItem'].includes(command);
      if (userAction) {
        if (!await tx.user.findUnique({ where: { id }, select: { id: true } })) throw new NotFoundException('User was not found');
        await this.restrictions.lock(tx, [id]);
      } else if (itemAction) await tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${id}::uuid FOR UPDATE`;
      else await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id}::uuid FOR UPDATE`;
      const value = userAction ? await tx.tradingRestriction.findUnique({ where: { userId: id } }) : itemAction ? await tx.item.findUnique({ where: { id } }) : await tx.order.findUnique({ where: { id } });
      if (!value) throw new NotFoundException('Risk resource was not found');
      await this.assertReportAssociation(tx, id, userAction ? 'USER' : itemAction ? 'ITEM' : 'ORDER', input.reportId);
      const previous = await replayRisk(tx, identity, requestHash);
      if (previous) return previous;
      if (value.version !== input.expectedVersion) throw new ConflictException('Risk resource has changed');
      await this.grants.consume(tx, context, { action, resourceId: id, expectedVersions: { expectedVersion: input.expectedVersion }, requestHash: operatorRequestHash(business) });
      const now = this.clock.now();
      let details: Prisma.InputJsonObject = {};
      if (userAction) {
        const current = await tx.tradingRestriction.findUniqueOrThrow({ where: { userId: id } });
        if ((command === 'freeze' && current.status !== 'CLEAR') || (command === 'unfreeze' && current.status !== 'FROZEN')) throw new ConflictException('Restriction is already in the requested state');
        await tx.tradingRestriction.update({ where: { userId: id }, data: { status: command === 'freeze' ? 'FROZEN' : 'CLEAR', reason: input.reason, actorId: context.actor.id, version: { increment: 1 }, ...(command === 'freeze' ? { frozenAt: now, releasedAt: null } : { releasedAt: now }) } });
      } else if (itemAction) {
        const item = await tx.item.findUniqueOrThrow({ where: { id } });
        const task = await tx.riskTask.findUnique({ where: { sourceKey: `item:${id}` } });
        if (command === 'unpublish') {
          if (item.status === 'INACTIVE' || (task && task.status !== 'RESOLVED')) throw new ConflictException('Item already has an active risk restriction');
          await tx.item.update({ where: { id }, data: { status: 'INACTIVE', version: { increment: 1 } } });
          const blocker = await tx.riskTask.upsert({ where: { sourceKey: `item:${id}` }, create: { sourceKey: `item:${id}`, kind: 'ITEM_UNPUBLISHED', reportId: input.reportId, description: input.reason }, update: { status: 'OPEN', reportId: input.reportId ?? null, description: input.reason } });
          details = { taskId: blocker.id };
        } else {
          if (!task || task.kind !== 'ITEM_UNPUBLISHED' || task.status === 'RESOLVED' || item.status !== 'INACTIVE') throw new ConflictException('No eligible item risk blocker');
          await tx.riskTask.update({ where: { id: task.id }, data: { status: 'RESOLVED' } });
          await tx.item.update({ where: { id }, data: { version: { increment: 1 } } });
          details = { taskId: task.id };
        }
      } else {
        const order = (await readOrder(tx, id))!;
        if (command === 'pause') {
          if (['COMPLETED', 'CANCELLED'].includes(order.status)) throw new ConflictException('Terminal orders cannot be paused');
          const task = await tx.riskTask.create({ data: { orderId: id, sourceKey: `order:${id}:pause:${randomUUID()}`, kind: 'OPERATOR_ORDER_PAUSE', description: input.reason, reportId: input.reportId } });
          await this.hold.enter(tx, order, input.reason, now, { kind: 'RISK', sourceId: task.id });
          details = { taskId: task.id };
        } else {
          if (['COMPLETED', 'CANCELLED'].includes(order.status)) throw new ConflictException('Terminal order risks require independent review');
          const blockerId = (input as ClearOrderRiskInput).blockerId;
          const blocker = await tx.orderHoldBlocker.findFirst({ where: { id: blockerId, orderId: id, kind: 'RISK', resolvedAt: null } });
          if (!blocker) throw new ConflictException('No eligible order risk blocker');
          if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(blocker.sourceId)) throw new ConflictException('Risk blocker provenance requires manual verification');
          const task = await tx.riskTask.findFirst({ where: { id: blocker.sourceId, orderId: id, kind: { in: ['OPERATOR_ORDER_PAUSE', 'SHIPMENT_EXCEPTION'] }, status: { not: 'RESOLVED' } } });
          if (!task) throw new ConflictException('Risk blocker provenance requires manual verification');
          await tx.orderHoldBlocker.update({ where: { id: blocker.id }, data: { resolvedAt: now } });
          await tx.riskTask.update({ where: { id: task.id }, data: { status: 'RESOLVED' } });
          details = { taskId: task.id, blockerId };
        }
        await tx.order.update({ where: { id }, data: { version: { increment: 1 } } });
      }
      const result = RiskCommandResultSchema.parse({ resourceId: id, version: value.version + 1 });
      const targetType = userAction ? 'USER' : itemAction ? 'ITEM' : 'ORDER';
      const updated = userAction ? await tx.tradingRestriction.findUniqueOrThrow({ where: { userId: id } }) : itemAction ? await tx.item.findUniqueOrThrow({ where: { id } }) : await tx.order.findUniqueOrThrow({ where: { id } });
      await tx.riskRecord.create({ data: { reportId: input.reportId, actorId: context.actor.id, targetType, targetId: id, action: identity.commandName, reason: input.reason, details } });
      await this.audit.record(tx, { actorId: context.actor.id, action: identity.commandName, entityType: userAction ? 'TradingRestriction' : itemAction ? 'Item' : 'Order', entityId: id, reason: input.reason, before: { status: value.status, version: value.version }, after: { ...result, status: updated.status, ...details } });
      await tx.idempotencyRecord.create({ data: { ...identity, requestHash, response: result } });
      return result;
    });
  }
  private async assertReportAssociation(tx: Prisma.TransactionClient, id: string, kind: 'USER' | 'ITEM' | 'ORDER', reportId?: string) {
    if (!reportId) return;
    const report = await tx.riskReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report was not found');
    if (kind === report.targetType && id === report.targetId) return;
    if (report.targetType === 'ITEM') {
      const item = await tx.item.findUnique({ where: { id: report.targetId } });
      if (kind === 'USER' && item?.ownerId === id) return;
    } else {
      const orderId = report.targetType === 'ORDER' ? report.targetId : (await tx.shipment.findUnique({ where: { id: report.targetId } }))?.orderId;
      const order = orderId ? await tx.order.findUnique({ where: { id: orderId } }) : null;
      if (order && ((kind === 'ORDER' && order.id === id) || (kind === 'USER' && [order.initiatorId, order.recipientId].includes(id)))) return;
    }
    throw new ConflictException('Report is not associated with this resource');
  }
}
