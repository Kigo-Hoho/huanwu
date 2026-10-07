import type { OrderRulesSnapshot } from '@barter/contracts';

export function testOrderRules(): OrderRulesSnapshot {
  return {
    version: 'phase3-test-v1', depositFen: 1000, feeFen: 0,
    detailsHours: 24, paymentHours: 24, fulfillmentHours: 72, inspectionHours: 72,
  };
}
