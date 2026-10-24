import { Injectable } from '@nestjs/common';
import { OriginalFundsPlanSchema } from '@barter/contracts';
import type { Prisma } from '../generated/prisma/client.js';
export type CaseFundsStatus = { complete: boolean; unknown: boolean; conflicting: boolean };
@Injectable()
export class CaseFundsStatusService {
  async inspect(tx: Prisma.TransactionClient, caseId: string): Promise<CaseFundsStatus> {
    const value = await tx.afterSalesCase.findUnique({ where: { id: caseId }, include: { resolutions: { include: { compensationObligations: { include: { progress: true, payment: { include: { entries: true } } } } } } } });
    if (!value) return { complete: false, unknown: true, conflicting: false };
    const current = value.resolutions.find(r => r.number === value.currentResolutionVersion);
    const payments = await tx.paymentIntent.findMany({ where: { orderId: value.orderId }, include: { entries: true } });
    const obligations = await tx.compensationObligation.findMany({ where: { rootDisputeId: value.rootDisputeId }, include: { progress: true, payment: { include: { entries: true } } } });
    const nos = [...payments.flatMap(p => [p.businessNo, `refund:${p.id}`, `settle:${p.id}`, `close:${p.id}`]), ...obligations.flatMap(o => o.payment ? [o.payment.businessNo, `compensation:refund:${o.payment.id}`, `compensation:disburse:${o.payment.id}`, `compensation:close:${o.payment.id}`] : [])];
    const facts = await tx.integrationEvent.findMany({ where: { businessNo: { in: nos } }, include: { receipt: true } });
    const accepted = await tx.simulatedProviderEvent.findMany({ where: { businessNo: { in: nos } } });
    const outbox = await tx.outboxCommand.findMany({ where: { businessNo: { in: nos } } });
    const unknown = payments.some(p => p.status === 'UNKNOWN') || obligations.some(o => o.progress?.status === 'UNKNOWN' || o.payment?.status === 'UNKNOWN') || facts.some(f => !f.receipt || f.receipt.status === 'PENDING') || accepted.some(a => !facts.some(f => f.provider === a.provider && f.eventId === a.eventId && f.receipt?.status !== 'PENDING')) || outbox.some(o => o.status === 'UNKNOWN' && !facts.some(f => f.businessNo === o.businessNo && f.receipt?.status === 'PROCESSED'));
    const conflicting = facts.some(f => f.receipt?.status === 'REJECTED') || !!await tx.riskTask.count({ where: { case: { rootDisputeId: value.rootDisputeId }, kind: 'FINANCIAL_CONFLICT', status: { not: 'RESOLVED' } } });
    let complete = !!current;
    if (current) {
      if (current.netCompensationFen && !current.compensationObligations.length) complete = false;
      for (const target of OriginalFundsPlanSchema.parse(current.originalFunds)) {
        const p = payments.find(p => p.id === target.paymentIntentId);
        if (!p) { complete = false; continue; }
        if (target.destination === 'RETAIN_FOR_EXCHANGE') continue;
        if (target.destination === 'REFUND_PAYER' ? !p.entries.some(e => e.entryType === 'REFUND' && e.amountFen === p.amountFen) && !(p.status === 'CLOSED' && p.closedAt && !p.entries.length) : !p.entries.some(e => e.entryType === 'DIFFERENCE_SETTLEMENT' && e.amountFen === p.amountFen)) complete = false;
      }
    }
    for (const o of obligations) {
      const p = o.payment;
      const terminal = p?.entries.filter(e => e.entryType !== 'COLLECTION') ?? [];
      if (!p || !o.progress?.completedAt || !((p.closedAt && !p.entries.length && o.progress.status === 'CLOSED') || (p.entries.some(e => e.entryType === 'COLLECTION' && e.amountFen === o.amountFen) && terminal.length === 1 && terminal[0].amountFen === o.amountFen && ['TRANSFERRED', 'REFUNDED'].includes(o.progress.status)))) complete = false;
    }
    return { complete: complete && !unknown && !conflicting, unknown, conflicting };
  }
}
