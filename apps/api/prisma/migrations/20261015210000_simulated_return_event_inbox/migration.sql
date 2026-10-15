CREATE TABLE "SimulatedProviderEvent" (
  "id" BIGSERIAL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "businessNo" TEXT NOT NULL REFERENCES "SimulatedProviderOperation"("businessNo") ON DELETE RESTRICT ON UPDATE CASCADE,
  "kind" "IntegrationEventKind" NOT NULL,
  "payload" JSONB NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SimulatedProviderEvent_return_kind" CHECK ("provider" = 'simulated' AND "kind" IN ('RETURN_PROGRESS', 'ORIGINAL_SHIPMENT_CLOSED')),
  CONSTRAINT "SimulatedProviderEvent_identity" CHECK (
    jsonb_typeof("payload") = 'object' AND
    ("payload"->>'provider' = "provider" AND "payload"->>'eventId' = "eventId" AND
     "payload"->>'businessNo' = "businessNo" AND "payload"->>'kind' = "kind"::text) IS TRUE
  )
);
CREATE UNIQUE INDEX "SimulatedProviderEvent_provider_eventId_key" ON "SimulatedProviderEvent"("provider", "eventId");
CREATE INDEX "SimulatedProviderEvent_businessNo_idx" ON "SimulatedProviderEvent"("businessNo");

-- Preserve recoverable facts already present at upgrade; do not manufacture
-- earlier overwritten events that the old simulator did not retain.
INSERT INTO "SimulatedProviderEvent" ("provider", "eventId", "businessNo", "kind", "payload", "acceptedAt")
SELECT 'simulated', "result"->'event'->>'eventId', "businessNo",
  ("result"->'event'->>'kind')::"IntegrationEventKind", "result"->'event', "updatedAt"
FROM "SimulatedProviderOperation"
WHERE "provider" = 'simulated' AND "status" = 'SUCCESS'
  AND "result"->'event'->>'kind' IN ('RETURN_PROGRESS', 'ORIGINAL_SHIPMENT_CLOSED');

CREATE FUNCTION immutable_simulated_provider_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Accepted simulated provider event is immutable'; END $$;
CREATE TRIGGER simulated_provider_event_immutable BEFORE UPDATE OR DELETE ON "SimulatedProviderEvent"
FOR EACH ROW EXECUTE FUNCTION immutable_simulated_provider_event();
