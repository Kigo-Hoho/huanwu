import { expect, it } from 'vitest';
import type { z } from 'zod';
import * as contracts from './index.js';
const schema = (name: string) => { const s = (contracts as unknown as Record<string, z.ZodType>)[name]; expect(s).toBeDefined(); return s!; };
const id = '00000000-0000-4000-8000-000000000001';
it('requires current plan and resource versions for active compensation payment', () => {
  const input = { expectedCaseVersion: 1, expectedOrderVersion: 1, resolutionVersion: 2, obligationId: id };
  expect(schema('CompensationPaymentSchema').safeParse(input).success).toBe(true);
  expect(schema('CompensationPaymentSchema').safeParse({ ...input, amountFen: 50 }).success).toBe(false);
  expect(schema('CompensationPaymentSchema').safeParse({ ...input, resolutionVersion: 0 }).success).toBe(false);
});
it('redacts checkout credentials and fixes CNY in compensation views', () => {
  const view = { id, amountFen: 60000, currency: 'CNY', payer: 'INITIATOR', status: 'PENDING', paymentDeadline: '2026-10-12T00:00:00.000Z' };
  expect(schema('CompensationViewSchema').safeParse(view).success).toBe(true);
  for (const change of [{ amountFen: 60001 }, { currency: 'USD' }, { checkoutParams: {} }]) expect(schema('CompensationViewSchema').safeParse({ ...view, ...change }).success).toBe(false);
});
