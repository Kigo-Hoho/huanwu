import { AdminCaseRecordViewSchema, AdminCaseViewSchema, AdminEvidenceViewSchema, AdminResolutionContextSchema, AdminResolutionViewSchema, CaseRecordViewSchema, CaseViewSchema, EvidenceViewSchema, ResolutionViewSchema } from '@barter/contracts';
import type { AfterSalesCase, CaseEvidence, CaseRecord, FinancialEntry, Prisma } from '../generated/prisma/client.js';
import type { LockedOrder } from '../orders/order.mapper.js';
import type { LockedCase } from './case.types.js';

export function mapCase(value: AfterSalesCase) {
  return CaseViewSchema.parse({
    id: value.id, orderId: value.orderId, rootDisputeId: value.rootDisputeId,
    status: value.status, version: value.version, reason: value.reason,
    currentResolutionVersion: value.currentResolutionVersion,
    responseDeadline: value.responseDeadline?.toISOString() ?? null,
    agreementDeadline: value.agreementDeadline?.toISOString() ?? null,
    createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(),
  });
}
export function mapAdminCase(value: AfterSalesCase) {
  // Deliberately project each management field independently of mapCase.
  return AdminCaseViewSchema.parse({
    id: value.id, orderId: value.orderId, rootDisputeId: value.rootDisputeId,
    status: value.status, version: value.version, reason: value.reason,
    currentResolutionVersion: value.currentResolutionVersion,
    responseDeadline: value.responseDeadline?.toISOString() ?? null,
    agreementDeadline: value.agreementDeadline?.toISOString() ?? null,
    createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString(),
  });
}
export function mapCaseRecord(record: CaseRecord, order: LockedOrder) {
  const participantSide = record.actorId === order.initiatorId ? 'INITIATOR' : record.actorId === order.recipientId ? 'RECIPIENT' : null;
  const details = record.details as Prisma.JsonObject | null;
  const requestedSide = details?.side === 'INITIATOR' || details?.side === 'RECIPIENT' ? details.side : null;
  return CaseRecordViewSchema.parse({
    id: record.id, kind: record.kind,
    actorKind: record.actorId === null ? 'SYSTEM' : participantSide ? 'CUSTOMER' : 'PLATFORM',
    side: participantSide ?? requestedSide, description: record.description, createdAt: record.createdAt.toISOString(),
  });
}
export function mapAdminCaseRecord(record: CaseRecord, order: LockedOrder) {
  const participantSide = record.actorId === order.initiatorId ? 'INITIATOR' : record.actorId === order.recipientId ? 'RECIPIENT' : null;
  const details = record.details as Prisma.JsonObject | null;
  const requestedSide = details?.side === 'INITIATOR' || details?.side === 'RECIPIENT' ? details.side : null;
  return AdminCaseRecordViewSchema.parse({
    id: record.id, kind: record.kind,
    actorKind: record.actorId === null ? 'SYSTEM' : participantSide ? 'CUSTOMER' : 'PLATFORM',
    side: participantSide ?? requestedSide, description: record.description, createdAt: record.createdAt.toISOString(),
  });
}
export function mapCaseEvidence(value: CaseEvidence) {
  return EvidenceViewSchema.parse({ id: value.id, uploaderId: value.uploaderId, description: value.description, mimeType: value.mimeType, bytes: value.bytes, width: value.width, height: value.height, sha256: value.sha256, createdAt: value.createdAt.toISOString() });
}
export function mapAdminCaseEvidence(value: CaseEvidence) {
  return AdminEvidenceViewSchema.parse({ id: value.id, description: value.description, mimeType: value.mimeType, bytes: value.bytes, width: value.width, height: value.height, sha256: value.sha256, createdAt: value.createdAt.toISOString() });
}
export function mapResolution(value: LockedCase['resolutions'][number]) {
  return ResolutionViewSchema.parse({ id: value.id, number: value.number, type: value.type, reason: value.reason, rulesVersion: value.rulesVersion, evidenceIds: value.evidenceIds, itemSnapshotIds: value.itemSnapshotIds, responsibility: value.responsibility, originalFunds: value.originalFunds, returnPlan: value.returnPlan, compensationComponents: value.compensationComponents, netCompensation: { amountFen: value.netCompensationFen, payer: value.compensationPayer }, orderOutcome: value.orderOutcome, createdAt: value.createdAt.toISOString(), consents: value.consents.map(c => ({ side: c.side, decision: c.decision, reason: c.reason, createdAt: c.createdAt.toISOString() })) });
}
export function mapAdminResolution(value: LockedCase['resolutions'][number]) {
  return AdminResolutionViewSchema.parse({ id: value.id, number: value.number, type: value.type, reason: value.reason, rulesVersion: value.rulesVersion, evidenceIds: value.evidenceIds, itemSnapshotIds: value.itemSnapshotIds, responsibility: value.responsibility, originalFunds: value.originalFunds, returnPlan: value.returnPlan, compensationComponents: value.compensationComponents, netCompensation: { amountFen: value.netCompensationFen, payer: value.compensationPayer }, orderOutcome: value.orderOutcome, createdAt: value.createdAt.toISOString(), consents: value.consents.map(c => ({ side: c.side, decision: c.decision, reason: c.reason, createdAt: c.createdAt.toISOString() })) });
}
export function mapAdminResolutionContext(order: LockedOrder, entries: FinancialEntry[]) {
  const amount = (id: string, kind: FinancialEntry['entryType']) => entries.find(e => e.intentId === id && e.entryType === kind)?.amountFen ?? 0;
  const difference = order.payments.find(p => p.purpose === 'DIFFERENCE');
  const settlementStatus = !difference ? 'UNPAID' : amount(difference.id, 'DIFFERENCE_SETTLEMENT') ? 'SETTLED'
    : amount(difference.id, 'REFUND') ? 'REFUNDED' : difference.status === 'UNKNOWN' ? 'UNKNOWN'
    : amount(difference.id, 'PAYMENT') ? 'PAID' : 'UNPAID';
  return AdminResolutionContextSchema.parse({
    orderStatus: order.status, orderVersion: order.version,
    itemSnapshots: [...order.items].sort((a, b) => a.id.localeCompare(b.id)).map(item => ({
      id: item.id, itemId: item.itemId, side: item.side,
      deliveryState: order.shipments.find(s => s.side === item.side)?.status
        ?? (order.parties.some(p => p.side === item.side && p.handedOverAt) ? 'HANDED_OVER' : 'UNDELIVERED'),
    })),
    originalPayments: [...order.payments].sort((a, b) => a.id.localeCompare(b.id)).map(payment => ({
      paymentIntentId: payment.id, side: payment.side, purpose: payment.purpose, status: payment.status, amountFen: payment.amountFen,
      collectedFen: amount(payment.id, 'PAYMENT'), refundedFen: amount(payment.id, 'REFUND'), settledFen: amount(payment.id, 'DIFFERENCE_SETTLEMENT'),
    })),
    originalDifference: { amountFen: order.differenceFen, payer: order.payer, settlementStatus },
  });
}
