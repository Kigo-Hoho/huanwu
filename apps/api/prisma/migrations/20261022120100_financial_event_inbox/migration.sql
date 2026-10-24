ALTER TABLE "SimulatedProviderEvent" DROP CONSTRAINT "SimulatedProviderEvent_return_kind";
ALTER TABLE "SimulatedProviderEvent" ADD CONSTRAINT "SimulatedProviderEvent_supported_kind" CHECK (
  provider = 'simulated' AND kind IN ('RETURN_PROGRESS', 'ORIGINAL_SHIPMENT_CLOSED', 'PAYMENT_SUCCEEDED', 'PAYMENT_CLOSED', 'REFUND_SUCCEEDED', 'DIFFERENCE_SETTLED')
);
-- Only current surviving results are recoverable at upgrade. Earlier overwritten
-- event bodies cannot be reconstructed and are intentionally not fabricated.
INSERT INTO "SimulatedProviderEvent" (provider, "eventId", "businessNo", kind, payload, "acceptedAt")
SELECT 'simulated', result->'event'->>'eventId', "businessNo", (result->'event'->>'kind')::"IntegrationEventKind", result->'event', "updatedAt"
FROM "SimulatedProviderOperation" WHERE provider='simulated' AND status='SUCCESS'
AND result->'event'->>'kind' IN ('PAYMENT_SUCCEEDED','PAYMENT_CLOSED','REFUND_SUCCEEDED','DIFFERENCE_SETTLED')
ON CONFLICT (provider,"eventId") DO NOTHING;
