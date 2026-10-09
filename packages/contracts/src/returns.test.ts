import { expect, it } from 'vitest';
import type { z } from 'zod';
import * as contracts from './index.js';
const schema = (name: string) => { const s = (contracts as unknown as Record<string, z.ZodType>)[name]; expect(s).toBeDefined(); return s!; };
const id = '00000000-0000-4000-8000-000000000001';
it('requires distinct immutable snapshots for a return parcel', () => {
  const input = { expectedCaseVersion: 1, expectedOrderVersion: 1, resolutionVersion: 1, obligationIds: [id], carrier: 'SF', trackingNumber: 'TRACK123' };
  expect(schema('ReturnShipmentSchema').safeParse(input).success).toBe(true);
  expect(schema('ReturnShipmentSchema').safeParse({ ...input, obligationIds: [id, id] }).success).toBe(false);
  expect(schema('ReturnShipmentSchema').safeParse({ ...input, businessNo: 'client-controlled' }).success).toBe(false);
});
it('redacts return addresses and encryption metadata from generic views', () => {
  const view = { id, itemSnapshotId: id, holderSide: 'INITIATOR', ownerSide: 'RECIPIENT', status: 'PENDING', registrationDeadline: '2026-10-12T00:00:00.000Z', receiptDeadline: null, confirmedAt: null };
  expect(schema('ReturnViewSchema').safeParse(view).success).toBe(true);
  expect(schema('ReturnViewSchema').safeParse({ ...view, ciphertext: 'private' }).success).toBe(false);
  expect(schema('ReturnViewSchema').safeParse({ ...view, ownerSide: 'INITIATOR' }).success).toBe(false);
});
