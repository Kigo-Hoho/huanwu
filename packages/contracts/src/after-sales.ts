import { z } from 'zod';
import { AdminEvidenceViewSchema, EvidenceViewSchema } from './evidence.js';
import { OrderSideSchema, OrderStatusSchema, PaymentPurposeSchema, PaymentStatusSchema } from './orders.js';
import { ProposalPayerSchema } from './proposals.js';
import { OperatorActionContextSchema } from './operator-security.js';

const uuid = z.string().uuid().toLowerCase();
const version = z.number().int().positive();
const time = z.iso.datetime();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const distinct = (ids: string[]) => new Set(ids).size === ids.length;
export const CaseStatusSchema = z.enum(['OPEN', 'AWAITING_RESPONSE', 'UNDER_REVIEW', 'AWAITING_AGREEMENT', 'EXECUTING', 'RESOLVED', 'REJECTED', 'WITHDRAWN']);
export const ResolutionTypeSchema = z.enum(['CONTINUE_EXCHANGE', 'RETURN_ORIGINALS', 'KEEP_WITH_COMPENSATION', 'CANCEL_BEFORE_HANDOVER', 'FUNDS_ONLY']);
export const ResolutionDecisionSchema = z.enum(['AGREE', 'REJECT']);
export const ResolutionResponsibilitySchema = z.enum(['NONE', 'INITIATOR', 'RECIPIENT', 'BOTH', 'UNDETERMINED']);
export const ResolutionOrderOutcomeSchema = z.enum(['RESUME', 'CANCEL', 'COMPLETE', 'PRESERVE_TERMINAL']);
export const CaseCommandSchema = z.strictObject({ expectedCaseVersion: version, expectedOrderVersion: version });
export const CreateCaseSchema = z.strictObject({ expectedOrderVersion: version, reason: text(1, 2000), previousCaseId: uuid.optional() });
export const ResolutionCommandSchema = z.strictObject({ ...CaseCommandSchema.shape, resolutionVersion: version });
export const CaseResponseSchema = z.strictObject({ ...CaseCommandSchema.shape, description: text(1, 2000) });
export const CaseWithdrawalSchema = z.strictObject({ ...CaseCommandSchema.shape, reason: text(1, 2000) });
export const CaseWithdrawalResponseSchema = z.strictObject({ ...CaseCommandSchema.shape, withdrawalRequestId: uuid, decision: ResolutionDecisionSchema, reason: text(1, 2000).optional() })
  .refine(v => v.decision !== 'REJECT' || Boolean(v.reason), 'Rejection requires a reason');
export const CaseEvidenceRequestSchema = z.strictObject({ ...CaseCommandSchema.shape, side: OrderSideSchema, reason: text(1, 2000) });
export const CaseRejectSchema = z.strictObject({ ...CaseCommandSchema.shape, reason: text(1, 2000) });
export const ResolutionConsentSchema = z.strictObject({ ...ResolutionCommandSchema.shape, decision: ResolutionDecisionSchema, reason: text(1, 2000).optional() })
  .refine(v => v.decision !== 'REJECT' || Boolean(v.reason), 'Rejection requires a reason');
export const ResolutionAdjudicationSchema = z.strictObject({ ...ResolutionCommandSchema.shape, reason: text(1, 2000), evidenceIds: z.array(uuid).max(60).refine(distinct), operatorAction: OperatorActionContextSchema });
export const NetCompensationSchema = z.strictObject({ amountFen: z.number().int().min(0).max(60000), payer: ProposalPayerSchema })
  .refine(v => v.amountFen === 0 ? v.payer === 'NONE' : v.payer !== 'NONE', 'Zero compensation requires NONE; positive compensation requires a payer');
export const CompensationComponentsSchema = z.strictObject({
  originalDifferenceReversal: NetCompensationSchema.refine(v => v.amountFen <= 20000, 'Original difference reversal exceeds Phase3 limit'),
  initiatorExtraFen: z.number().int().min(0).max(20000), recipientExtraFen: z.number().int().min(0).max(20000),
  initiatorShippingFen: z.number().int().min(0).max(20000), recipientShippingFen: z.number().int().min(0).max(20000),
});
export const OriginalFundsDestinationSchema = z.enum(['RETAIN_FOR_EXCHANGE', 'REFUND_PAYER', 'SETTLE_BENEFICIARY']);
export const OriginalFundsPlanSchema = z.array(z.strictObject({ paymentIntentId: uuid, destination: OriginalFundsDestinationSchema })).max(3)
  .refine(v => distinct(v.map(p => p.paymentIntentId)), 'Each original payment requires one destination');
export const ResolutionReturnPlanSchema = z.array(z.strictObject({
  itemSnapshotId: uuid, outcome: z.enum(['RETURN_ORIGINAL', 'UNDELIVERED', 'INTERCEPT_VERIFIED', 'UNRETURNABLE_RULING']),
})).max(6).refine(v => distinct(v.map(p => p.itemSnapshotId)), 'Each snapshot requires one return outcome');
export const ResolutionInputSchema = z.strictObject({
  ...ResolutionCommandSchema.shape, type: ResolutionTypeSchema, reason: text(1, 2000), rulesVersion: text(1, 100),
  evidenceIds: z.array(uuid).max(60).refine(distinct), itemSnapshotIds: z.array(uuid).min(2).max(6).refine(distinct),
  responsibility: ResolutionResponsibilitySchema, originalFunds: OriginalFundsPlanSchema, returnPlan: ResolutionReturnPlanSchema,
  compensationComponents: CompensationComponentsSchema, netCompensation: NetCompensationSchema, orderOutcome: ResolutionOrderOutcomeSchema,
}).refine(v => {
  const c = v.compensationComponents;
  const reversal = c.originalDifferenceReversal.amountFen * (c.originalDifferenceReversal.payer === 'RECIPIENT' ? -1 : 1);
  const signed = reversal + c.initiatorExtraFen + c.initiatorShippingFen - c.recipientExtraFen - c.recipientShippingFen;
  return v.netCompensation.amountFen === Math.abs(signed) && v.netCompensation.payer === (signed === 0 ? 'NONE' : signed > 0 ? 'INITIATOR' : 'RECIPIENT');
}, 'Net compensation must match the individual components').refine(v =>
  v.orderOutcome === 'PRESERVE_TERMINAL' ||
  (v.type === 'CONTINUE_EXCHANGE' && v.orderOutcome === 'RESUME') ||
  (v.type === 'KEEP_WITH_COMPENSATION' && v.orderOutcome === 'COMPLETE') ||
  (['RETURN_ORIGINALS', 'CANCEL_BEFORE_HANDOVER'].includes(v.type) && v.orderOutcome === 'CANCEL'),
  'Resolution outcome must match its type');
export const CaseViewSchema = z.strictObject({
  id: uuid, orderId: uuid, rootDisputeId: uuid, status: CaseStatusSchema, version,
  reason: text(1, 2000), currentResolutionVersion: version.nullable(), responseDeadline: time.nullable(), agreementDeadline: time.nullable(),
  createdAt: time, updatedAt: time,
});
const resolutionFields = {
  id: uuid, number: version, type: ResolutionTypeSchema, reason: text(1, 2000), rulesVersion: text(1, 100),
  evidenceIds: z.array(uuid), itemSnapshotIds: z.array(uuid), responsibility: ResolutionResponsibilitySchema,
  originalFunds: OriginalFundsPlanSchema, returnPlan: ResolutionReturnPlanSchema,
  compensationComponents: CompensationComponentsSchema, netCompensation: NetCompensationSchema,
  orderOutcome: ResolutionOrderOutcomeSchema, createdAt: time,
  consents: z.array(z.strictObject({ side: OrderSideSchema, decision: ResolutionDecisionSchema, reason: text(1, 2000).nullable(), createdAt: time })),
};
export const ResolutionViewSchema = z.strictObject(resolutionFields);
// Deliberate allowlist, independent of future customer-only view additions.
export const AdminResolutionViewSchema = z.strictObject({ ...resolutionFields });
export const AdminResolutionContextSchema = z.strictObject({
  orderStatus: OrderStatusSchema, orderVersion: version,
  itemSnapshots: z.array(z.strictObject({ id: uuid, itemId: uuid, side: OrderSideSchema, deliveryState: z.enum(['UNDELIVERED', 'REGISTERED', 'COLLECTED', 'DELIVERED', 'EXCEPTION', 'HANDED_OVER']) })).max(6),
  originalPayments: z.array(z.strictObject({ paymentIntentId: uuid, side: OrderSideSchema, purpose: PaymentPurposeSchema, status: PaymentStatusSchema, amountFen: z.number().int().positive(), collectedFen: z.number().int().nonnegative(), refundedFen: z.number().int().nonnegative(), settledFen: z.number().int().nonnegative() })).max(3),
  originalDifference: z.strictObject({ amountFen: z.number().int().min(0).max(20000), payer: ProposalPayerSchema, settlementStatus: z.enum(['UNPAID', 'PAID', 'SETTLED', 'REFUNDED', 'UNKNOWN']) }),
});
// Keep the management projection explicit: later participant-only fields must
// never become visible to operators by extending the customer schema.
export const AdminCaseViewSchema = z.strictObject({
  id: uuid, orderId: uuid, rootDisputeId: uuid, status: CaseStatusSchema, version,
  reason: text(1, 2000), currentResolutionVersion: version.nullable(), responseDeadline: time.nullable(), agreementDeadline: time.nullable(),
  createdAt: time, updatedAt: time,
});
export const CaseListViewSchema = z.strictObject({ items: z.array(CaseViewSchema), nextCursor: z.string().nullable() });
export const CaseListQuerySchema = z.strictObject({ cursor: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(50).default(20), status: CaseStatusSchema.optional() });
export const CaseCommandResultSchema = z.strictObject({ case: CaseViewSchema, orderVersion: version });
export const AdminCaseCommandResultSchema = z.strictObject({ case: AdminCaseViewSchema, orderVersion: version });
export const CaseRecordViewSchema = z.strictObject({ id: uuid, kind: text(1, 100), actorKind: z.enum(['CUSTOMER', 'PLATFORM', 'SYSTEM']), side: OrderSideSchema.nullable(), description: text(1, 2000), createdAt: time });
export const AdminCaseRecordViewSchema = z.strictObject({ id: uuid, kind: text(1, 100), actorKind: z.enum(['CUSTOMER', 'PLATFORM', 'SYSTEM']), side: OrderSideSchema.nullable(), description: text(1, 2000), createdAt: time });
export const CaseDetailViewSchema = z.strictObject({ ...CaseViewSchema.shape, records: z.array(CaseRecordViewSchema), evidence: z.array(EvidenceViewSchema).default([]), resolutions: z.array(ResolutionViewSchema).default([]) });
export const AdminCaseDetailViewSchema = z.strictObject({ ...AdminCaseViewSchema.shape, records: z.array(AdminCaseRecordViewSchema), evidence: z.array(AdminEvidenceViewSchema).default([]), resolutions: z.array(AdminResolutionViewSchema).default([]), resolutionContext: AdminResolutionContextSchema.optional() });
export const AdminCaseListViewSchema = z.strictObject({ items: z.array(AdminCaseViewSchema), nextCursor: z.string().nullable() });
export type CaseStatus = z.infer<typeof CaseStatusSchema>;
export type ResolutionType = z.infer<typeof ResolutionTypeSchema>;
export type ResolutionDecision = z.infer<typeof ResolutionDecisionSchema>;
export type ResolutionResponsibility = z.infer<typeof ResolutionResponsibilitySchema>;
export type ResolutionOrderOutcome = z.infer<typeof ResolutionOrderOutcomeSchema>;
export type OriginalFundsDestination = z.infer<typeof OriginalFundsDestinationSchema>;
export type OriginalFundsPlan = z.infer<typeof OriginalFundsPlanSchema>;
export type ResolutionReturnPlan = z.infer<typeof ResolutionReturnPlanSchema>;
export type CaseCommandInput = z.infer<typeof CaseCommandSchema>;
export type CreateCaseInput = z.infer<typeof CreateCaseSchema>;
export type ResolutionCommandInput = z.infer<typeof ResolutionCommandSchema>;
export type CaseResponseInput = z.infer<typeof CaseResponseSchema>;
export type CaseWithdrawalInput = z.infer<typeof CaseWithdrawalSchema>;
export type CaseWithdrawalResponseInput = z.infer<typeof CaseWithdrawalResponseSchema>;
export type CaseEvidenceRequestInput = z.infer<typeof CaseEvidenceRequestSchema>;
export type CaseRejectInput = z.infer<typeof CaseRejectSchema>;
export type ResolutionConsentInput = z.infer<typeof ResolutionConsentSchema>;
export type ResolutionAdjudicationInput = z.infer<typeof ResolutionAdjudicationSchema>;
export type ResolutionInput = z.infer<typeof ResolutionInputSchema>;
export type NetCompensation = z.infer<typeof NetCompensationSchema>;
export type CompensationComponents = z.infer<typeof CompensationComponentsSchema>;
export type CaseView = z.infer<typeof CaseViewSchema>;
export type AdminCaseView = z.infer<typeof AdminCaseViewSchema>;
export type CaseListView = z.infer<typeof CaseListViewSchema>;
export type CaseListQuery = z.infer<typeof CaseListQuerySchema>;
export type CaseCommandResult = z.infer<typeof CaseCommandResultSchema>;
export type CaseRecordView = z.infer<typeof CaseRecordViewSchema>;
export type AdminCaseRecordView = z.infer<typeof AdminCaseRecordViewSchema>;
export type CaseDetailView = z.infer<typeof CaseDetailViewSchema>;
export type AdminCaseDetailView = z.infer<typeof AdminCaseDetailViewSchema>;
export type AdminCaseListView = z.infer<typeof AdminCaseListViewSchema>;
export type AdminCaseCommandResult = z.infer<typeof AdminCaseCommandResultSchema>;
