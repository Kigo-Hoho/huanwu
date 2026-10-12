import { AdminCaseRecordViewSchema, AdminCaseViewSchema, CaseRecordViewSchema, CaseViewSchema } from '@barter/contracts';
import type { AfterSalesCase, CaseRecord, Prisma } from '../generated/prisma/client.js';
import type { LockedOrder } from '../orders/order.mapper.js';

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
