CREATE TABLE "EvidenceCleanupJob" (
  "id" UUID NOT NULL,
  "creatorInstance" UUID NOT NULL,
  "creatorPid" INTEGER NOT NULL,
  "creatorHost" TEXT NOT NULL,
  "storageScope" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'OPEN',
  "objects" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvidenceCleanupJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EvidenceCleanupJob_state_check" CHECK ("state" IN ('OPEN', 'READY')),
  CONSTRAINT "EvidenceCleanupJob_pid_check" CHECK ("creatorPid" > 0),
  CONSTRAINT "EvidenceCleanupJob_objects_check" CHECK (
    jsonb_typeof("objects") = 'array' AND jsonb_array_length("objects") BETWEEN 1 AND 18
  )
);
CREATE INDEX "EvidenceCleanupJob_creatorHost_storageScope_state_createdAt_idx"
ON "EvidenceCleanupJob"("creatorHost", "storageScope", "state", "createdAt");
