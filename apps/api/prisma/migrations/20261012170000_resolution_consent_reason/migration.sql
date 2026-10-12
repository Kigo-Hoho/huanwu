-- CHECK accepts UNKNOWN: require a real reason for a rejection explicitly.
-- Existing invalid history is never rewritten; migration fails for inspection.
ALTER TABLE "ResolutionConsent" ADD CONSTRAINT "ResolutionConsent_reject_reason_required"
  CHECK (decision <> 'REJECT' OR (reason IS NOT NULL AND length(reason) BETWEEN 1 AND 2000));

ALTER TYPE "OperatorAction" ADD VALUE 'ADJUDICATE_RESOLUTION';
