ALTER TABLE "OperatorDevice" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "OperatorDevice" ADD CONSTRAINT "OperatorDevice_version_check" CHECK (version > 0);
-- Device management advances an optimistic version with every approval/revocation.
DROP TRIGGER "OperatorDevice_metadata" ON "OperatorDevice";
CREATE TRIGGER "OperatorDevice_metadata" BEFORE UPDATE OR DELETE ON "OperatorDevice" FOR EACH ROW EXECUTE FUNCTION protect_after_sales_metadata('version,capability,status,approvedById,approvedAt,revokedAt,updatedAt');
ALTER TABLE "OperatorSession" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "OperatorSession" ADD CONSTRAINT "OperatorSession_version_check" CHECK (version > 0);
DROP TRIGGER "OperatorSession_metadata" ON "OperatorSession";
CREATE TRIGGER "OperatorSession_metadata" BEFORE UPDATE OR DELETE ON "OperatorSession" FOR EACH ROW EXECUTE FUNCTION protect_after_sales_metadata('version,revokedAt');
