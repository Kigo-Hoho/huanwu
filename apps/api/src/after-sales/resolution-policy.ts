import { CompensationComponentsSchema, NetCompensationSchema, type CompensationComponents, type NetCompensation, type OriginalFundsPlan, type ResolutionInput, type ResolutionOrderOutcome } from '@barter/contracts';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { CaseMutationContext, LockedCase } from './case.types.js';

export function invalidResolution(message: string): never {
  throw new BadRequestException({ code: 'VALIDATION_FAILED', message });
}
export function resolveCompensation(input: CompensationComponents, originalDifferenceFen: number): NetCompensation {
  const parsed = CompensationComponentsSchema.safeParse(input);
  if (!parsed.success) invalidResolution('Invalid compensation components');
  const c = parsed.data;
  if (c.originalDifferenceReversal.amountFen > originalDifferenceFen) invalidResolution('Reversal exceeds original difference');
  const signed = c.originalDifferenceReversal.amountFen * (c.originalDifferenceReversal.payer === 'RECIPIENT' ? -1 : 1)
    + c.initiatorExtraFen + c.initiatorShippingFen - c.recipientExtraFen - c.recipientShippingFen;
  const result = NetCompensationSchema.safeParse({ amountFen: Math.abs(signed), payer: signed === 0 ? 'NONE' : signed > 0 ? 'INITIATOR' : 'RECIPIENT' });
  if (!result.success) invalidResolution('Net compensation exceeds its bounds');
  return result.data;
}
export function currentResolution(value: LockedCase, number: number) {
  const resolution = value.resolutions.find(r => r.number === number);
  if (value.currentResolutionVersion !== number || !resolution) throw new ConflictException({ code: 'RESOLUTION_VERSION_CONFLICT', message: 'Only the current resolution can be acted on' });
  return resolution;
}
export function assertResolutionNotExecuting(value: LockedCase): void {
  if (value.status === 'EXECUTING' || value.resolutions.some(r => r.executions.length > 0)) {
    throw new ConflictException({ code: 'AFTER_SALES_NOT_ELIGIBLE', message: 'An executed resolution requires reconciled termination and a successor case' });
  }
}
export function assertCaseEvidence(value: LockedCase, ids: string[]): void {
  if (ids.some(id => !value.evidence.some(e => e.id === id))) invalidResolution('Evidence must belong to this case');
}
export async function deriveResolution(ctx: CaseMutationContext, input: ResolutionInput) {
  const { tx, order, case: value } = ctx;
  assertCaseEvidence(value, input.evidenceIds);
  const snapshotIds = order.items.map(item => item.id).sort();
  if (JSON.stringify([...input.itemSnapshotIds].sort()) !== JSON.stringify(snapshotIds)) invalidResolution('Resolution must cover exactly the snapshots of this order');
  const terminal = ['COMPLETED', 'CANCELLED'].includes(order.status);
  if (order.status === 'CANCELLED' && input.type !== 'FUNDS_ONLY') invalidResolution('Cancelled orders allow funds-only resolutions');
  if (terminal && ['CONTINUE_EXCHANGE', 'CANCEL_BEFORE_HANDOVER'].includes(input.type)) invalidResolution('Historical terminal exchanges cannot resume or cancel again');
  if (!terminal && input.type === 'FUNDS_ONLY') invalidResolution('Funds-only resolutions preserve a terminal order');
  const orderOutcome: ResolutionOrderOutcome = terminal ? 'PRESERVE_TERMINAL'
    : input.type === 'CONTINUE_EXCHANGE' ? 'RESUME' : input.type === 'KEEP_WITH_COMPENSATION' ? 'COMPLETE' : 'CANCEL';
  if (input.orderOutcome !== orderOutcome) invalidResolution('Order outcome differs from the server-derived outcome');
  if (input.rulesVersion !== 'phase4-simulation-v1') invalidResolution('Unsupported resolution rules version');
  const netCompensation = resolveCompensation(input.compensationComponents, order.differenceFen);
  if (netCompensation.amountFen !== input.netCompensation.amountFen || netCompensation.payer !== input.netCompensation.payer) invalidResolution('Net compensation differs from server calculation');

  const payments = await tx.paymentIntent.findMany({ where: { orderId: order.id }, include: { entries: true }, orderBy: { id: 'asc' } });
  const originalFunds: OriginalFundsPlan = payments.map(payment => ({
    paymentIntentId: payment.id,
    destination: payment.entries.some(e => e.entryType === 'REFUND') ? 'REFUND_PAYER'
      : payment.entries.some(e => e.entryType === 'DIFFERENCE_SETTLEMENT') ? 'SETTLE_BENEFICIARY'
      : input.type === 'CONTINUE_EXCHANGE' ? 'RETAIN_FOR_EXCHANGE'
      : input.type === 'KEEP_WITH_COMPENSATION' && payment.purpose === 'DIFFERENCE' ? 'SETTLE_BENEFICIARY' : 'REFUND_PAYER',
  }));
  if (JSON.stringify([...input.originalFunds].sort((a, b) => a.paymentIntentId.localeCompare(b.paymentIntentId))) !== JSON.stringify(originalFunds)) invalidResolution('Original funds destinations must match locked payment facts and resolution type');
  const reversal = input.compensationComponents.originalDifferenceReversal;
  if (reversal.amountFen > 0) {
    const difference = payments.find(p => p.purpose === 'DIFFERENCE' && p.entries.some(e => e.entryType === 'DIFFERENCE_SETTLEMENT'));
    if (!difference || reversal.payer !== (order.payer === 'INITIATOR' ? 'RECIPIENT' : 'INITIATOR')) invalidResolution('Only a settled difference can be reversed, by its original beneficiary');
    if (await tx.compensationObligation.count({ where: { rootDisputeId: value.rootDisputeId, originalPaymentIntentId: difference.id } })) {
      throw new ConflictException({ code: 'FUNDS_UNRESOLVED', message: 'Original difference already has a reversal obligation' });
    }
  }
  const transferred = (side: string) => order.shipments.some(s => s.side === side) || order.parties.some(p => p.side === side && p.handedOverAt !== null);
  if (input.type === 'CANCEL_BEFORE_HANDOVER' && order.items.some(item => transferred(item.side))) {
    throw new ConflictException({ code: 'ORDER_FULFILLMENT_STARTED', message: 'Registered shipment or handover prevents cancellation before handover' });
  }
  if (['RETURN_ORIGINALS', 'CANCEL_BEFORE_HANDOVER'].includes(input.type)) {
    if (JSON.stringify(input.returnPlan.map(p => p.itemSnapshotId).sort()) !== JSON.stringify(snapshotIds)) invalidResolution('Every snapshot needs a return outcome');
    for (const plan of input.returnPlan) {
      const item = order.items.find(item => item.id === plan.itemSnapshotId)!;
      if (plan.outcome === 'UNDELIVERED' && transferred(item.side)) invalidResolution('Registered shipments and handovers cannot be declared undelivered');
      if (plan.outcome === 'RETURN_ORIGINAL' && !transferred(item.side)) invalidResolution('Undelivered items need no fictional reverse shipment');
      if (plan.outcome === 'INTERCEPT_VERIFIED') {
        const verified = await tx.returnObligation.findFirst({ where: { itemSnapshotId: item.id, resolution: { case: { rootDisputeId: value.rootDisputeId } }, progress: { status: 'INTERCEPTED' } } });
        if (!verified) invalidResolution('Interception requires a verified existing fact');
      }
      if (plan.outcome === 'UNRETURNABLE_RULING' && (!input.evidenceIds.length || ['NONE', 'UNDETERMINED'].includes(input.responsibility))) invalidResolution('Unreturnable rulings require evidence and responsibility');
    }
  } else if (input.returnPlan.length) invalidResolution('This resolution has no return obligations');
  return { netCompensation, originalFunds, orderOutcome, itemSnapshotIds: snapshotIds };
}
