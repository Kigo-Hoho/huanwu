import { describe, expect, it } from 'vitest';
import { reservationIsAvailable } from './reservation-policy.js';

describe('reservation availability', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const lease = { itemId: 'item', proposalId: 'proposal', proposalVersionId: 'version', orderId: null, expiresAt: now, createdAt: now };
  it('makes an absent or inclusively expired proposal lease available', () => {
    expect(reservationIsAvailable(null, now)).toBe(true);
    expect(reservationIsAvailable(lease, now)).toBe(true);
    expect(reservationIsAvailable({ ...lease, expiresAt: new Date(now.getTime() + 1) }, now)).toBe(false);
  });
  it('keeps an order occupied regardless of elapsed proposal time', () => {
    expect(reservationIsAvailable({ ...lease, proposalId: null, proposalVersionId: null, orderId: 'order', expiresAt: null }, new Date('2099-01-01'))).toBe(false);
  });
});
