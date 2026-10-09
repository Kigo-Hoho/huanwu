import { expect, it } from 'vitest';
import type { z } from 'zod';
import * as contracts from './index.js';

function schema(name: string): z.ZodType {
  const value = (contracts as unknown as Record<string, z.ZodType>)[name];
  expect(value, `public contract ${name}`).toBeDefined();
  return value!;
}
const id = '00000000-0000-4000-8000-000000000001';
const now = '2026-10-09T00:00:00.000Z';
it('pins the inclusive net compensation ceiling and zero payer', () => {
  const net = schema('NetCompensationSchema');
  expect(net.parse({ amountFen: 60000, payer: 'INITIATOR' })).toEqual({ amountFen: 60000, payer: 'INITIATOR' });
  expect(net.safeParse({ amountFen: 60001, payer: 'INITIATOR' }).success).toBe(false);
  expect(net.safeParse({ amountFen: 0, payer: 'INITIATOR' }).success).toBe(false);
  expect(net.parse({ amountFen: 0, payer: 'NONE' })).toEqual({ amountFen: 0, payer: 'NONE' });
});
it.each([{ amountFen: 1.5, payer: 'INITIATOR' }, { amountFen: -1, payer: 'RECIPIENT' }, { amountFen: 1, payer: 'NONE' }, { amountFen: 1, payer: 'INITIATOR', account: 'arbitrary' }])('rejects malformed compensation %j', input => {
  expect(schema('NetCompensationSchema').safeParse(input).success).toBe(false);
});
it('requires both resource versions and rejects client-controlled command fields', () => {
  const command = schema('CaseCommandSchema');
  expect(command.parse({ expectedCaseVersion: 1, expectedOrderVersion: 2 })).toEqual({ expectedCaseVersion: 1, expectedOrderVersion: 2 });
  for (const input of [{ expectedCaseVersion: 1 }, { expectedCaseVersion: 0, expectedOrderVersion: 1 }, { expectedCaseVersion: 1, expectedOrderVersion: 1, actorId: id }]) expect(command.safeParse(input).success).toBe(false);
});
it('keeps credentials and private keys out of case command results', () => {
  const view = { id, orderId: id, rootDisputeId: id, status: 'OPEN', version: 1, reason: '物品存在争议', currentResolutionVersion: null, responseDeadline: null, agreementDeadline: null, createdAt: now, updatedAt: now };
  expect(schema('CaseCommandResultSchema').safeParse({ case: view, orderVersion: 2 }).success).toBe(true);
  expect(schema('CaseCommandResultSchema').safeParse({ case: { ...view, storageKey: 'private' }, orderVersion: 2 }).success).toBe(false);
  expect(schema('CaseCommandResultSchema').safeParse({ case: view, orderVersion: 2, grant: 'private' }).success).toBe(false);
  expect(schema('CaseViewSchema').safeParse({ ...view, createdAt: '2026-10-09T08:00:00+08:00' }).success).toBe(false);
});
it('bounds each compensation component independently', () => {
  const components = { originalDifferenceReversal: { amountFen: 20000, payer: 'INITIATOR' }, initiatorExtraFen: 20000, recipientExtraFen: 20000, initiatorShippingFen: 20000, recipientShippingFen: 20000 };
  expect(schema('CompensationComponentsSchema').safeParse(components).success).toBe(true);
  for (const field of ['initiatorExtraFen', 'recipientExtraFen', 'initiatorShippingFen', 'recipientShippingFen']) expect(schema('CompensationComponentsSchema').safeParse({ ...components, [field]: 20001 }).success).toBe(false);
});
it('requires explicit original funds destinations and rejects duplicate references', () => {
  const plan = schema('OriginalFundsPlanSchema');
  expect(plan.safeParse([{ paymentIntentId: id, destination: 'REFUND_PAYER' }]).success).toBe(true);
  expect(plan.safeParse([{ paymentIntentId: id, destination: 'DECIDE_LATER' }]).success).toBe(false);
  expect(plan.safeParse([{ paymentIntentId: id, destination: 'REFUND_PAYER' }, { paymentIntentId: id, destination: 'SETTLE_BENEFICIARY' }]).success).toBe(false);
});
it('validates a complete resolution and derives its net direction from bounded components', () => {
  const input = {
    expectedCaseVersion: 1, expectedOrderVersion: 1, resolutionVersion: 1,
    type: 'CONTINUE_EXCHANGE', reason: '按原条款继续履约', rulesVersion: 'phase4-simulation-v1', evidenceIds: [],
    itemSnapshotIds: [id, '00000000-0000-4000-8000-000000000002'], responsibility: 'INITIATOR', originalFunds: [], returnPlan: [],
    compensationComponents: { originalDifferenceReversal: { amountFen: 0, payer: 'NONE' }, initiatorExtraFen: 500, recipientExtraFen: 100, initiatorShippingFen: 0, recipientShippingFen: 0 },
    netCompensation: { amountFen: 400, payer: 'INITIATOR' }, orderOutcome: 'RESUME',
  };
  const resolution = schema('ResolutionInputSchema');
  expect(resolution.safeParse(input).success).toBe(true);
  expect(resolution.safeParse({ ...input, netCompensation: { amountFen: 400, payer: 'RECIPIENT' } }).success).toBe(false);
  expect(resolution.safeParse({ ...input, orderOutcome: 'CANCEL' }).success).toBe(false);
});
