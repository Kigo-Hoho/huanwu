ALTER TYPE "IntegrationOperationKind" ADD VALUE 'VERIFY_RETURN';
ALTER TYPE "IntegrationOperationKind" ADD VALUE 'CLOSE_OR_INTERCEPT';
ALTER TYPE "IntegrationEventKind" ADD VALUE 'RETURN_PROGRESS';
ALTER TYPE "IntegrationEventKind" ADD VALUE 'ORIGINAL_SHIPMENT_CLOSED';
ALTER TABLE "ReturnProgress" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0);
CREATE TABLE "OriginalShipmentClosure" (
  "shipmentId" UUID PRIMARY KEY REFERENCES "Shipment"("id") ON DELETE RESTRICT,
  "resolutionId" UUID NOT NULL REFERENCES "ResolutionVersion"("id") ON DELETE RESTRICT,
  "outcome" TEXT NOT NULL CHECK ("outcome" IN ('DELIVERED', 'INTERCEPTED')),
  "eventId" UUID NOT NULL UNIQUE REFERENCES "IntegrationEvent"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "ShipmentTrackingIdentity" (
  "trackingNumber" TEXT PRIMARY KEY,
  "shipmentId" UUID NOT NULL UNIQUE,
  "source" TEXT NOT NULL CHECK ("source" IN ('Shipment','ReturnShipment'))
);
-- Existing facts are never rewritten. Ambiguous historic reuse fails migration
-- for manual reconciliation rather than choosing an arbitrary shipment owner.
INSERT INTO "ShipmentTrackingIdentity" SELECT upper(trim("trackingNumber")), id, 'Shipment' FROM "Shipment";
INSERT INTO "ShipmentTrackingIdentity" SELECT upper(trim("trackingNumber")), id, 'ReturnShipment' FROM "ReturnShipment";
CREATE FUNCTION reserve_shipment_tracking_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW."trackingNumber" IS DISTINCT FROM OLD."trackingNumber" OR NEW.carrier IS DISTINCT FROM OLD.carrier OR NEW."businessNo" IS DISTINCT FROM OLD."businessNo" THEN
      RAISE EXCEPTION 'Shipment identity is immutable';
    END IF;
  ELSE
    INSERT INTO "ShipmentTrackingIdentity" VALUES (upper(trim(NEW."trackingNumber")), NEW.id, TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipment_tracking_identity BEFORE INSERT OR UPDATE ON "Shipment" FOR EACH ROW EXECUTE FUNCTION reserve_shipment_tracking_identity();
CREATE TRIGGER return_tracking_identity BEFORE INSERT OR UPDATE ON "ReturnShipment" FOR EACH ROW EXECUTE FUNCTION reserve_shipment_tracking_identity();
CREATE FUNCTION immutable_return_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Return fact is immutable'; END $$;
CREATE TRIGGER closure_immutable BEFORE UPDATE OR DELETE ON "OriginalShipmentClosure" FOR EACH ROW EXECUTE FUNCTION immutable_return_identity();
CREATE TRIGGER tracking_identity_immutable BEFORE UPDATE OR DELETE ON "ShipmentTrackingIdentity" FOR EACH ROW EXECUTE FUNCTION immutable_return_identity();
