import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { assertPureCustomer } from '../auth/customer-only.guard.js';
import type { LockedOrder } from '../orders/order.mapper.js';
import type { CaseTx, LockedCase } from './case.types.js';

export function assertCaseParticipant(order: LockedOrder | null, value: LockedCase | null, actorId: string): asserts value is LockedCase {
  if (!order || !value || (order.initiatorId !== actorId && order.recipientId !== actorId)) {
    throw new NotFoundException({ code: 'AFTER_SALES_NOT_FOUND', message: 'After-sales case was not found' });
  }
}
export async function assertCurrentCustomer(tx: CaseTx, actor: AuthenticatedUser): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.id}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT "userId" FROM "UserRole" WHERE "userId" = ${actor.id}::uuid FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: actor.id }, include: { roles: true, adminCredential: true } });
  if (!user || user.disabledAt || !user.wechatOpenid || user.adminCredential) {
    throw new UnauthorizedException('Customer identity is unavailable');
  }
  assertPureCustomer({ id: actor.id, roles: user.roles.map(r => r.role) });
}
export function assertCaseOperator(actor: AuthenticatedUser): void {
  if (actor.roles.includes('CUSTOMER') || !actor.roles.some(role => ['OPERATIONS', 'SUPER_ADMIN'].includes(role))) {
    throw new ForbiddenException('After-sales processing permission required');
  }
}
export function assertOpenCase(value: LockedCase): void {
  if (value.closedAt || ['RESOLVED', 'REJECTED', 'WITHDRAWN'].includes(value.status)) {
    throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'Case is closed' });
  }
}
export async function assertCaseEligibility(tx: CaseTx, order: LockedOrder, now: Date): Promise<void> {
  if (order.status === 'COMPLETED') {
    if (!order.completedAt) {
      throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'Historical completion time requires manual verification', manualVerificationRequired: true });
    }
    if (now < order.completedAt || now.getTime() >= order.completedAt.getTime() + 7 * 86400000) {
      throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'The seven-day after-sales application period has ended' });
    }
  }
  if (order.status === 'CANCELLED') {
    // Eligibility follows persisted refund/payment facts, never keywords in the reason.
    const payments = await tx.paymentIntent.findMany({ where: { orderId: order.id }, include: { entries: true } });
    const commands = await tx.outboxCommand.findMany({ where: { orderId: order.id, kind: { in: ['CREATE_PAYMENT', 'REFUND_PAYMENT'] }, status: { not: 'SUCCEEDED' } } });
    const anomaly = payments.some(payment => {
      if (payment.entries.some(entry => entry.entryType === 'REFUND')) return false;
      if (payment.entries.some(entry => entry.entryType === 'PAYMENT')) return true;
      return commands.some(command => {
        const payload = command.payload as { paymentBusinessNo?: unknown; amountFen?: unknown; currency?: unknown };
        if (command.kind === 'REFUND_PAYMENT') {
          return command.businessNo === `refund:${payment.id}`
            && payload.paymentBusinessNo === payment.businessNo
            && payload.amountFen === payment.amountFen
            && payload.currency === 'CNY';
        }
        return payment.status === 'UNKNOWN' && command.businessNo === payment.businessNo;
      });
    });
    if (!anomaly) {
      throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'Cancelled orders allow unresolved refund cases only' });
    }
  }
}
export async function assertSafeCaseClosure(tx: CaseTx, order: LockedOrder, value: LockedCase): Promise<void> {
  const liveRisk = await tx.riskTask.count({ where: { OR: [{ orderId: order.id }, { case: { rootDisputeId: value.rootDisputeId } }], status: { not: 'RESOLVED' } } });
  const blockers = await tx.orderHoldBlocker.count({ where: { orderId: order.id, resolvedAt: null, NOT: { kind: 'CASE', sourceId: value.id } } });
  if (liveRisk || blockers || order.shipments.some(s => s.status === 'EXCEPTION')) {
    throw new ConflictException({ code: 'RISK_BLOCKS_RESUME', message: 'Active risk prevents case closure; withdrawal request remains recorded' });
  }
  const pendingCommands = await tx.outboxCommand.count({ where: { orderId: order.id, status: { not: 'SUCCEEDED' } } });
  const payments = await tx.paymentIntent.findMany({ where: { orderId: order.id } });
  const businessNos = [...payments.flatMap(p => [p.businessNo, `refund:${p.id}`, `settle:${p.id}`, `close:${p.id}`]), ...order.shipments.map(s => s.businessNo)];
  const pendingFacts = businessNos.length ? await tx.integrationEvent.count({ where: { businessNo: { in: businessNos }, OR: [{ receipt: null }, { receipt: { status: { not: 'PROCESSED' } } }] } }) : 0;
  if (pendingCommands || pendingFacts || order.payments.some(p => p.status === 'UNKNOWN')) {
    throw new ConflictException({ code: 'FUNDS_UNRESOLVED', message: 'External instructions or facts require verification before closure' });
  }
  // Read completion markers from the owning domains. Missing/unknown progress
  // requires their later reconciliation workflow; this command never writes
  // execution, return or money completion on their behalf.
  const sameDispute = { resolution: { case: { rootDisputeId: value.rootDisputeId } } };
  const executions = await tx.resolutionExecution.findMany({ where: sameDispute, include: { progress: true } });
  const returns = await tx.returnObligation.findMany({ where: sameDispute, include: { progress: true } });
  let pending = value.status === 'EXECUTING'
    || executions.some(execution => execution.progress?.status !== 'SUCCEEDED' || !execution.progress.completedAt)
    || returns.some(obligation => !obligation.progress
      || !['CONFIRMED', 'INTERCEPTED', 'UNRETURNABLE'].includes(obligation.progress.status)
      || (obligation.progress.status === 'CONFIRMED' && !obligation.progress.confirmedAt));
  const compensation = await tx.compensationObligation.findMany({ where: sameDispute });
  for (const obligation of compensation) {
    const progress = await tx.compensationProgress.findUnique({ where: { obligationId: obligation.id } });
    const payment = await tx.compensationPayment.findUnique({ where: { obligationId: obligation.id } });
    const entries = payment ? await tx.compensationFinancialEntry.findMany({ where: { paymentId: payment.id } }) : [];
    const collected = entries.some(entry => entry.entryType === 'COLLECTION');
    const disposed = (kind: 'TRANSFER' | 'REFUND') => entries.some(entry =>
      entry.entryType === kind
      && entry.amountFen === obligation.amountFen
      && entry.currency === 'CNY'
      && entry.provider === payment?.provider);
    const safelyClosed = progress?.status === 'CLOSED' && !collected && (!payment || (['CLOSED', 'FAILED'].includes(payment.status) && !payment.paidAt));
    const transferred = progress?.status === 'TRANSFERRED' && Boolean(payment?.transferredAt) && collected && disposed('TRANSFER');
    const refunded = progress?.status === 'REFUNDED' && Boolean(payment?.refundedAt) && collected && disposed('REFUND');
    if (!progress?.completedAt || !(safelyClosed || transferred || refunded)) pending = true;
  }
  if (pending) {
    throw new ConflictException({ code: 'FUNDS_UNRESOLVED', message: 'Existing execution obligations require reconciliation before closure' });
  }
}
