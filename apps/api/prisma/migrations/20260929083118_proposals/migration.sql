-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProposalSide" AS ENUM ('INITIATOR', 'RECIPIENT');

-- CreateEnum
CREATE TYPE "ProposalPayer" AS ENUM ('NONE', 'INITIATOR', 'RECIPIENT');

-- CreateEnum
CREATE TYPE "DeliveryMode" AS ENUM ('COURIER', 'IN_PERSON');

-- AlterTable
ALTER TABLE "IdempotencyRecord" ADD COLUMN     "requestHash" TEXT;

-- CreateTable
CREATE TABLE "Proposal" (
    "id" UUID NOT NULL,
    "initiatorId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "responderId" UUID NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "reservationExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalVersion" (
    "id" UUID NOT NULL,
    "proposalId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "authorId" UUID NOT NULL,
    "differenceFen" INTEGER NOT NULL,
    "payer" "ProposalPayer" NOT NULL,
    "deliveryMode" "DeliveryMode" NOT NULL,
    "initiatorShippingFen" INTEGER NOT NULL,
    "recipientShippingFen" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalVersionItem" (
    "id" UUID NOT NULL,
    "proposalVersionId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "side" "ProposalSide" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "itemVersion" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "referenceValueFen" INTEGER NOT NULL,
    "condition" "ItemCondition" NOT NULL,
    "wantedText" TEXT NOT NULL,
    "imageUrls" TEXT[],

    CONSTRAINT "ProposalVersionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemReservation" (
    "itemId" UUID NOT NULL,
    "proposalId" UUID NOT NULL,
    "proposalVersionId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemReservation_pkey" PRIMARY KEY ("itemId")
);

-- CreateIndex
CREATE INDEX "Proposal_initiatorId_createdAt_id_idx" ON "Proposal"("initiatorId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Proposal_recipientId_createdAt_id_idx" ON "Proposal"("recipientId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Proposal_status_expiresAt_idx" ON "Proposal"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Proposal_status_reservationExpiresAt_idx" ON "Proposal"("status", "reservationExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProposalVersion_proposalId_number_key" ON "ProposalVersion"("proposalId", "number");

-- CreateIndex
CREATE INDEX "ProposalVersionItem_itemId_idx" ON "ProposalVersionItem"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "ProposalVersionItem_proposalVersionId_itemId_key" ON "ProposalVersionItem"("proposalVersionId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "ProposalVersionItem_proposalVersionId_side_sortOrder_key" ON "ProposalVersionItem"("proposalVersionId", "side", "sortOrder");

-- CreateIndex
CREATE INDEX "ItemReservation_proposalId_idx" ON "ItemReservation"("proposalId");

-- CreateIndex
CREATE INDEX "ItemReservation_expiresAt_idx" ON "ItemReservation"("expiresAt");

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_responderId_fkey" FOREIGN KEY ("responderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalVersion" ADD CONSTRAINT "ProposalVersion_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalVersion" ADD CONSTRAINT "ProposalVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalVersionItem" ADD CONSTRAINT "ProposalVersionItem_proposalVersionId_fkey" FOREIGN KEY ("proposalVersionId") REFERENCES "ProposalVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalVersionItem" ADD CONSTRAINT "ProposalVersionItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemReservation" ADD CONSTRAINT "ItemReservation_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemReservation" ADD CONSTRAINT "ItemReservation_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemReservation" ADD CONSTRAINT "ItemReservation_proposalVersionId_fkey" FOREIGN KEY ("proposalVersionId") REFERENCES "ProposalVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain bounds supplement Prisma's scalar types. Cross-row ownership,
-- cardinality and active-state checks belong to the transactional command service.
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_participants_check"
  CHECK ("initiatorId" <> "recipientId" AND "responderId" IN ("initiatorId", "recipientId"));
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_versions_check"
  CHECK ("version" > 0 AND "currentVersion" > 0 AND "version" >= "currentVersion");
ALTER TABLE "ProposalVersion" ADD CONSTRAINT "ProposalVersion_terms_check"
  CHECK ("number" > 0 AND "differenceFen" BETWEEN 0 AND 20000
    AND (("differenceFen" = 0 AND "payer" = 'NONE') OR ("differenceFen" > 0 AND "payer" <> 'NONE'))
    AND "initiatorShippingFen" >= 0 AND "recipientShippingFen" >= 0
    AND ("deliveryMode" <> 'IN_PERSON' OR ("initiatorShippingFen" = 0 AND "recipientShippingFen" = 0)));
ALTER TABLE "ProposalVersionItem" ADD CONSTRAINT "ProposalVersionItem_snapshot_check"
  CHECK ("itemVersion" > 0 AND "referenceValueFen" BETWEEN 100 AND 1000000
    AND "imageUrls" IS NOT NULL AND cardinality("imageUrls") BETWEEN 3 AND 9
    AND (("side" = 'INITIATOR' AND "sortOrder" BETWEEN 0 AND 4) OR ("side" = 'RECIPIENT' AND "sortOrder" = 0)));

CREATE FUNCTION reject_proposal_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Proposal history is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "ProposalVersion_immutable" BEFORE UPDATE OR DELETE ON "ProposalVersion"
  FOR EACH ROW EXECUTE FUNCTION reject_proposal_history_mutation();
CREATE TRIGGER "ProposalVersionItem_immutable" BEFORE UPDATE OR DELETE ON "ProposalVersionItem"
  FOR EACH ROW EXECUTE FUNCTION reject_proposal_history_mutation();
