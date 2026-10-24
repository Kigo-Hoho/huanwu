-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'AWAITING_RESPONSE', 'UNDER_REVIEW', 'AWAITING_AGREEMENT', 'EXECUTING', 'RESOLVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ResolutionType" AS ENUM ('CONTINUE_EXCHANGE', 'RETURN_ORIGINALS', 'KEEP_WITH_COMPENSATION', 'CANCEL_BEFORE_HANDOVER', 'FUNDS_ONLY');

-- CreateEnum
CREATE TYPE "ResolutionDecision" AS ENUM ('AGREE', 'REJECT');

-- CreateEnum
CREATE TYPE "ResolutionResponsibility" AS ENUM ('NONE', 'INITIATOR', 'RECIPIENT', 'BOTH', 'UNDETERMINED');

-- CreateEnum
CREATE TYPE "ResolutionOrderOutcome" AS ENUM ('RESUME', 'CANCEL', 'COMPLETE', 'PRESERVE_TERMINAL');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('PENDING', 'REGISTERED', 'COLLECTED', 'DELIVERED', 'CONFIRMED', 'DISPUTED', 'INTERCEPTED', 'UNRETURNABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CompensationStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'COLLECTED', 'TRANSFERRING', 'TRANSFERRED', 'REFUNDING', 'REFUNDED', 'CLOSED', 'UNKNOWN', 'FAILED');

-- CreateEnum
CREATE TYPE "CompensationFinancialEntryType" AS ENUM ('COLLECTION', 'TRANSFER', 'REFUND');

-- CreateEnum
CREATE TYPE "RiskReportStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'ACTIONED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RiskTargetType" AS ENUM ('ITEM', 'SHIPMENT', 'ORDER');

-- CreateEnum
CREATE TYPE "RiskReason" AS ENUM ('PROHIBITED_ITEM', 'FALSE_SHIPMENT', 'FRAUDULENT_TRADE', 'OTHER');

-- CreateEnum
CREATE TYPE "TradingRestrictionStatus" AS ENUM ('CLEAR', 'FROZEN');

-- CreateEnum
CREATE TYPE "RiskTaskStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "OperatorCapability" AS ENUM ('MOBILE_LIMITED', 'DESKTOP_PRIVILEGED');

-- CreateEnum
CREATE TYPE "OperatorDeviceStatus" AS ENUM ('PENDING', 'APPROVED', 'REVOKED');

-- CreateEnum
CREATE TYPE "OperatorAction" AS ENUM ('FREEZE_TRADING', 'UNFREEZE_TRADING', 'UNPUBLISH_ITEM', 'HOLD_ORDER', 'RESUME_ORDER', 'APPROVE_FUNDS', 'EXECUTE_FUNDS', 'APPROVE_DEVICE', 'REVOKE_DEVICE');

-- CreateEnum
CREATE TYPE "HoldBlockerKind" AS ENUM ('CASE', 'RISK', 'FUNDS', 'LOGISTICS');

-- CreateEnum
CREATE TYPE "OrderDeadlineKind" AS ENUM ('DETAILS', 'PAYMENT', 'FULFILLMENT', 'ACCEPTANCE');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "completedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AfterSalesCase" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "rootDisputeId" UUID NOT NULL,
    "applicantId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "currentResolutionVersion" INTEGER,
    "responseSide" "OrderSide",
    "responseDeadline" TIMESTAMP(3),
    "agreementDeadline" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AfterSalesCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseRecord" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "actorId" UUID,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseEvidence" (
    "id" UUID NOT NULL,
    "caseId" UUID,
    "reportId" UUID,
    "uploaderId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "originalKey" TEXT NOT NULL,
    "displayKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionVersion" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "authorId" UUID NOT NULL,
    "type" "ResolutionType" NOT NULL,
    "reason" TEXT NOT NULL,
    "rulesVersion" TEXT NOT NULL,
    "evidenceIds" UUID[],
    "itemSnapshotIds" UUID[],
    "responsibility" "ResolutionResponsibility" NOT NULL,
    "originalFunds" JSONB NOT NULL,
    "returnPlan" JSONB NOT NULL,
    "compensationComponents" JSONB NOT NULL,
    "netCompensationFen" INTEGER NOT NULL,
    "compensationPayer" "ProposalPayer" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "orderOutcome" "ResolutionOrderOutcome" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResolutionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionConsent" (
    "id" UUID NOT NULL,
    "resolutionId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "decision" "ResolutionDecision" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResolutionConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionApproval" (
    "id" UUID NOT NULL,
    "resolutionId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResolutionApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionExecution" (
    "id" UUID NOT NULL,
    "resolutionId" UUID NOT NULL,
    "executionStep" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "originalPaymentIntentId" UUID,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResolutionExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionExecutionProgress" (
    "executionId" UUID NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResolutionExecutionProgress_pkey" PRIMARY KEY ("executionId")
);

-- CreateTable
CREATE TABLE "ReturnObligation" (
    "id" UUID NOT NULL,
    "resolutionId" UUID NOT NULL,
    "itemSnapshotId" UUID NOT NULL,
    "holderSide" "OrderSide" NOT NULL,
    "ownerSide" "OrderSide" NOT NULL,
    "deliveryMode" "DeliveryMode" NOT NULL,
    "registrationDeadline" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnProgress" (
    "obligationId" UUID NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'PENDING',
    "receiptDeadline" TIMESTAMP(3),
    "handedOverAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnProgress_pkey" PRIMARY KEY ("obligationId")
);

-- CreateTable
CREATE TABLE "ReturnAddress" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "keyVersion" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "frozenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnShipment" (
    "id" UUID NOT NULL,
    "resolutionId" UUID NOT NULL,
    "holderSide" "OrderSide" NOT NULL,
    "ownerSide" "OrderSide" NOT NULL,
    "carrier" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "businessNo" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'REGISTERED',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collectedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnShipmentItem" (
    "shipmentId" UUID NOT NULL,
    "obligationId" UUID NOT NULL,

    CONSTRAINT "ReturnShipmentItem_pkey" PRIMARY KEY ("shipmentId","obligationId")
);

-- CreateTable
CREATE TABLE "ReturnEvent" (
    "id" UUID NOT NULL,
    "obligationId" UUID,
    "shipmentId" UUID,
    "actorId" UUID,
    "provider" TEXT,
    "providerEventId" TEXT,
    "kind" TEXT NOT NULL,
    "details" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationObligation" (
    "id" UUID NOT NULL,
    "resolutionId" UUID NOT NULL,
    "rootDisputeId" UUID NOT NULL,
    "executionStep" TEXT NOT NULL,
    "originalPaymentIntentId" UUID,
    "payerSide" "OrderSide" NOT NULL,
    "payeeSide" "OrderSide" NOT NULL,
    "amountFen" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "paymentDeadline" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationProgress" (
    "obligationId" UUID NOT NULL,
    "status" "CompensationStatus" NOT NULL DEFAULT 'PENDING',
    "authorizedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompensationProgress_pkey" PRIMARY KEY ("obligationId")
);

-- CreateTable
CREATE TABLE "CompensationPayment" (
    "id" UUID NOT NULL,
    "obligationId" UUID NOT NULL,
    "businessNo" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "amountFen" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "checkoutParams" JSONB,
    "paidAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "transferredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompensationPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationFinancialEntry" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "integrationEventId" UUID,
    "entryType" "CompensationFinancialEntryType" NOT NULL,
    "provider" TEXT NOT NULL,
    "externalTransactionId" TEXT NOT NULL,
    "businessNo" TEXT NOT NULL,
    "amountFen" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationFinancialEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskReport" (
    "id" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "targetType" "RiskTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "reason" "RiskReason" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "RiskReportStatus" NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskRecord" (
    "id" UUID NOT NULL,
    "reportId" UUID,
    "actorId" UUID NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingRestriction" (
    "userId" UUID NOT NULL,
    "status" "TradingRestrictionStatus" NOT NULL DEFAULT 'CLEAR',
    "version" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT,
    "actorId" UUID,
    "frozenAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingRestriction_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RiskTask" (
    "id" UUID NOT NULL,
    "orderId" UUID,
    "caseId" UUID,
    "reportId" UUID,
    "sourceKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "RiskTaskStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorDevice" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "credentialDigest" TEXT NOT NULL,
    "capability" "OperatorCapability" NOT NULL DEFAULT 'MOBILE_LIMITED',
    "status" "OperatorDeviceStatus" NOT NULL DEFAULT 'PENDING',
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorSession" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "capability" "OperatorCapability" NOT NULL,
    "credentialDigest" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionGrant" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "action" "OperatorAction" NOT NULL,
    "resourceId" UUID NOT NULL,
    "expectedVersion" INTEGER NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderHoldBlocker" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "kind" "HoldBlockerKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderHoldBlocker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderDeadlineExtension" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "resolutionId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "kind" "OrderDeadlineKind" NOT NULL,
    "originalDeadline" TIMESTAMP(3),
    "newDeadline" TIMESTAMP(3) NOT NULL,
    "affectedSides" "OrderSide"[],
    "reason" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDeadlineExtension_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AfterSalesCase_orderId_createdAt_id_idx" ON "AfterSalesCase"("orderId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AfterSalesCase_status_responseDeadline_idx" ON "AfterSalesCase"("status", "responseDeadline");

-- CreateIndex
CREATE INDEX "AfterSalesCase_rootDisputeId_idx" ON "AfterSalesCase"("rootDisputeId");

-- CreateIndex
CREATE INDEX "CaseRecord_caseId_createdAt_id_idx" ON "CaseRecord"("caseId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CaseEvidence_originalKey_key" ON "CaseEvidence"("originalKey");

-- CreateIndex
CREATE UNIQUE INDEX "CaseEvidence_displayKey_key" ON "CaseEvidence"("displayKey");

-- CreateIndex
CREATE INDEX "CaseEvidence_caseId_uploaderId_idx" ON "CaseEvidence"("caseId", "uploaderId");

-- CreateIndex
CREATE INDEX "CaseEvidence_reportId_uploaderId_idx" ON "CaseEvidence"("reportId", "uploaderId");

-- CreateIndex
CREATE UNIQUE INDEX "ResolutionVersion_caseId_number_key" ON "ResolutionVersion"("caseId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ResolutionConsent_resolutionId_side_key" ON "ResolutionConsent"("resolutionId", "side");

-- CreateIndex
CREATE UNIQUE INDEX "ResolutionApproval_grantId_key" ON "ResolutionApproval"("grantId");

-- CreateIndex
CREATE UNIQUE INDEX "ResolutionApproval_resolutionId_actorId_key" ON "ResolutionApproval"("resolutionId", "actorId");

-- CreateIndex
CREATE UNIQUE INDEX "ResolutionExecution_originalPaymentIntentId_key" ON "ResolutionExecution"("originalPaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "ResolutionExecution_resolutionId_executionStep_key" ON "ResolutionExecution"("resolutionId", "executionStep");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnObligation_resolutionId_itemSnapshotId_key" ON "ReturnObligation"("resolutionId", "itemSnapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnAddress_caseId_side_key" ON "ReturnAddress"("caseId", "side");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnShipment_businessNo_key" ON "ReturnShipment"("businessNo");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnShipment_carrier_trackingNumber_key" ON "ReturnShipment"("carrier", "trackingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnShipmentItem_obligationId_key" ON "ReturnShipmentItem"("obligationId");

-- CreateIndex
CREATE INDEX "ReturnEvent_obligationId_occurredAt_idx" ON "ReturnEvent"("obligationId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnEvent_provider_providerEventId_key" ON "ReturnEvent"("provider", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationObligation_originalPaymentIntentId_key" ON "CompensationObligation"("originalPaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationObligation_resolutionId_executionStep_key" ON "CompensationObligation"("resolutionId", "executionStep");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationObligation_rootDisputeId_originalPaymentIntentI_key" ON "CompensationObligation"("rootDisputeId", "originalPaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationPayment_obligationId_key" ON "CompensationPayment"("obligationId");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationPayment_businessNo_key" ON "CompensationPayment"("businessNo");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationFinancialEntry_businessNo_key" ON "CompensationFinancialEntry"("businessNo");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationFinancialEntry_paymentId_entryType_key" ON "CompensationFinancialEntry"("paymentId", "entryType");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationFinancialEntry_provider_externalTransactionId_e_key" ON "CompensationFinancialEntry"("provider", "externalTransactionId", "entryType");

-- CreateIndex
CREATE INDEX "RiskReport_reporterId_createdAt_id_idx" ON "RiskReport"("reporterId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "RiskReport_status_createdAt_id_idx" ON "RiskReport"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "RiskRecord_reportId_createdAt_id_idx" ON "RiskRecord"("reportId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RiskTask_sourceKey_key" ON "RiskTask"("sourceKey");

-- CreateIndex
CREATE INDEX "RiskTask_status_createdAt_id_idx" ON "RiskTask"("status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorDevice_credentialDigest_key" ON "OperatorDevice"("credentialDigest");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorSession_credentialDigest_key" ON "OperatorSession"("credentialDigest");

-- CreateIndex
CREATE INDEX "OperatorSession_actorId_expiresAt_idx" ON "OperatorSession"("actorId", "expiresAt");

-- CreateIndex
CREATE INDEX "ActionGrant_actorId_expiresAt_idx" ON "ActionGrant"("actorId", "expiresAt");

-- CreateIndex
CREATE INDEX "OrderHoldBlocker_orderId_resolvedAt_idx" ON "OrderHoldBlocker"("orderId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderHoldBlocker_orderId_kind_sourceId_key" ON "OrderHoldBlocker"("orderId", "kind", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderDeadlineExtension_orderId_kind_key" ON "OrderDeadlineExtension"("orderId", "kind");

-- AddForeignKey
ALTER TABLE "AfterSalesCase" ADD CONSTRAINT "AfterSalesCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AfterSalesCase" ADD CONSTRAINT "AfterSalesCase_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseRecord" ADD CONSTRAINT "CaseRecord_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AfterSalesCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseRecord" ADD CONSTRAINT "CaseRecord_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseEvidence" ADD CONSTRAINT "CaseEvidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AfterSalesCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseEvidence" ADD CONSTRAINT "CaseEvidence_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "RiskReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseEvidence" ADD CONSTRAINT "CaseEvidence_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionVersion" ADD CONSTRAINT "ResolutionVersion_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AfterSalesCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionVersion" ADD CONSTRAINT "ResolutionVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionConsent" ADD CONSTRAINT "ResolutionConsent_resolutionId_fkey" FOREIGN KEY ("resolutionId") REFERENCES "ResolutionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionConsent" ADD CONSTRAINT "ResolutionConsent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionApproval" ADD CONSTRAINT "ResolutionApproval_resolutionId_fkey" FOREIGN KEY ("resolutionId") REFERENCES "ResolutionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionApproval" ADD CONSTRAINT "ResolutionApproval_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionApproval" ADD CONSTRAINT "ResolutionApproval_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "OperatorSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionApproval" ADD CONSTRAINT "ResolutionApproval_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "ActionGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionExecution" ADD CONSTRAINT "ResolutionExecution_resolutionId_fkey" FOREIGN KEY ("resolutionId") REFERENCES "ResolutionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionExecution" ADD CONSTRAINT "ResolutionExecution_originalPaymentIntentId_fkey" FOREIGN KEY ("originalPaymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionExecution" ADD CONSTRAINT "ResolutionExecution_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionExecutionProgress" ADD CONSTRAINT "ResolutionExecutionProgress_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ResolutionExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnObligation" ADD CONSTRAINT "ReturnObligation_resolutionId_fkey" FOREIGN KEY ("resolutionId") REFERENCES "ResolutionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnObligation" ADD CONSTRAINT "ReturnObligation_itemSnapshotId_fkey" FOREIGN KEY ("itemSnapshotId") REFERENCES "OrderItemSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnProgress" ADD CONSTRAINT "ReturnProgress_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "ReturnObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnAddress" ADD CONSTRAINT "ReturnAddress_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AfterSalesCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnShipment" ADD CONSTRAINT "ReturnShipment_resolutionId_fkey" FOREIGN KEY ("resolutionId") REFERENCES "ResolutionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnShipmentItem" ADD CONSTRAINT "ReturnShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "ReturnShipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnShipmentItem" ADD CONSTRAINT "ReturnShipmentItem_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "ReturnObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnEvent" ADD CONSTRAINT "ReturnEvent_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "ReturnObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnEvent" ADD CONSTRAINT "ReturnEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "ReturnShipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnEvent" ADD CONSTRAINT "ReturnEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationObligation" ADD CONSTRAINT "CompensationObligation_resolutionId_fkey" FOREIGN KEY ("resolutionId") REFERENCES "ResolutionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationObligation" ADD CONSTRAINT "CompensationObligation_originalPaymentIntentId_fkey" FOREIGN KEY ("originalPaymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationProgress" ADD CONSTRAINT "CompensationProgress_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "CompensationObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationPayment" ADD CONSTRAINT "CompensationPayment_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "CompensationObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationFinancialEntry" ADD CONSTRAINT "CompensationFinancialEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "CompensationPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationFinancialEntry" ADD CONSTRAINT "CompensationFinancialEntry_integrationEventId_fkey" FOREIGN KEY ("integrationEventId") REFERENCES "IntegrationEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskReport" ADD CONSTRAINT "RiskReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskRecord" ADD CONSTRAINT "RiskRecord_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "RiskReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskRecord" ADD CONSTRAINT "RiskRecord_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingRestriction" ADD CONSTRAINT "TradingRestriction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingRestriction" ADD CONSTRAINT "TradingRestriction_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskTask" ADD CONSTRAINT "RiskTask_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskTask" ADD CONSTRAINT "RiskTask_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "AfterSalesCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskTask" ADD CONSTRAINT "RiskTask_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "RiskReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorDevice" ADD CONSTRAINT "OperatorDevice_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorDevice" ADD CONSTRAINT "OperatorDevice_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorSession" ADD CONSTRAINT "OperatorSession_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorSession" ADD CONSTRAINT "OperatorSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "OperatorDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionGrant" ADD CONSTRAINT "ActionGrant_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionGrant" ADD CONSTRAINT "ActionGrant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "OperatorSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionGrant" ADD CONSTRAINT "ActionGrant_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "OperatorDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderHoldBlocker" ADD CONSTRAINT "OrderHoldBlocker_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDeadlineExtension" ADD CONSTRAINT "OrderDeadlineExtension_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDeadlineExtension" ADD CONSTRAINT "OrderDeadlineExtension_resolutionId_fkey" FOREIGN KEY ("resolutionId") REFERENCES "ResolutionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDeadlineExtension" ADD CONSTRAINT "OrderDeadlineExtension_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PostgreSQL-only constraints cannot be represented by Prisma's schema DSL.
CREATE UNIQUE INDEX "AfterSalesCase_one_open" ON "AfterSalesCase" ("orderId")
  WHERE status NOT IN ('RESOLVED', 'REJECTED', 'WITHDRAWN');
CREATE UNIQUE INDEX "RiskReport_one_open_target" ON "RiskReport" ("reporterId","targetType","targetId",reason)
  WHERE status IN ('OPEN','INVESTIGATING');
ALTER TABLE "AfterSalesCase" ADD CONSTRAINT "AfterSalesCase_bounds_check" CHECK (
  version > 0 AND ("currentResolutionVersion" IS NULL OR "currentResolutionVersion" > 0)
  AND length(reason) BETWEEN 1 AND 2000
  AND ((status IN ('RESOLVED','REJECTED','WITHDRAWN')) = ("closedAt" IS NOT NULL))
);
ALTER TABLE "CaseEvidence" ADD CONSTRAINT "CaseEvidence_scope_check" CHECK (num_nonnulls("caseId","reportId")=1);
ALTER TABLE "CaseEvidence" ADD CONSTRAINT "CaseEvidence_image_check" CHECK (
  bytes BETWEEN 1 AND 8388608 AND width BETWEEN 1 AND 8192 AND height BETWEEN 1 AND 8192
  AND width::bigint*height <= 40000000 AND "mimeType" IN ('image/jpeg','image/png','image/webp')
  AND sha256 ~ '^[a-f0-9]{64}$' AND length(description) BETWEEN 1 AND 2000
  AND length("originalKey")>0 AND length("displayKey")>0 AND "originalKey"<>"displayKey"
);
ALTER TABLE "ResolutionVersion" ADD CONSTRAINT "ResolutionVersion_bounds_check" CHECK (
  number>0 AND "netCompensationFen" BETWEEN 0 AND 60000 AND currency='CNY'
  AND (("netCompensationFen"=0 AND "compensationPayer"='NONE') OR ("netCompensationFen">0 AND "compensationPayer"<>'NONE'))
  AND length(reason) BETWEEN 1 AND 2000 AND length("rulesVersion")>0
  AND "itemSnapshotIds" IS NOT NULL AND cardinality("itemSnapshotIds") BETWEEN 2 AND 6
  AND jsonb_typeof("originalFunds")='array' AND jsonb_typeof("returnPlan")='array'
  AND jsonb_typeof("compensationComponents")='object'
);
ALTER TABLE "ResolutionConsent" ADD CONSTRAINT "ResolutionConsent_rejection_check" CHECK (decision<>'REJECT' OR length(reason) BETWEEN 1 AND 2000);
ALTER TABLE "ReturnObligation" ADD CONSTRAINT "ReturnObligation_direction_check" CHECK ("holderSide"<>"ownerSide");
ALTER TABLE "ReturnShipment" ADD CONSTRAINT "ReturnShipment_direction_check" CHECK ("holderSide"<>"ownerSide");
ALTER TABLE "ReturnAddress" ADD CONSTRAINT "ReturnAddress_encryption_check" CHECK (
  version>0 AND length("keyVersion")>0 AND octet_length(ciphertext)>0 AND octet_length(nonce)=12 AND octet_length(tag)=16
);
ALTER TABLE "ReturnEvent" ADD CONSTRAINT "ReturnEvent_scope_check" CHECK ("obligationId" IS NOT NULL OR "shipmentId" IS NOT NULL);
ALTER TABLE "CompensationObligation" ADD CONSTRAINT "CompensationObligation_amount_check" CHECK (
  "amountFen" BETWEEN 1 AND 60000 AND currency='CNY' AND "payerSide"<>"payeeSide" AND length("executionStep")>0
);
ALTER TABLE "CompensationPayment" ADD CONSTRAINT "CompensationPayment_amount_check" CHECK ("amountFen" BETWEEN 1 AND 60000 AND currency='CNY' AND NOT ("refundedAt" IS NOT NULL AND "transferredAt" IS NOT NULL));
ALTER TABLE "CompensationFinancialEntry" ADD CONSTRAINT "CompensationFinancialEntry_amount_check" CHECK ("amountFen" BETWEEN 1 AND 60000 AND currency='CNY');
ALTER TABLE "TradingRestriction" ADD CONSTRAINT "TradingRestriction_version_check" CHECK (version>0);
ALTER TABLE "RiskReport" ADD CONSTRAINT "RiskReport_bounds_check" CHECK (version>0 AND length(description) BETWEEN 1 AND 2000);
ALTER TABLE "OperatorDevice" ADD CONSTRAINT "OperatorDevice_digest_check" CHECK ("credentialDigest" ~ '^[a-f0-9]{64}$' AND "approvedById" IS DISTINCT FROM "actorId");
ALTER TABLE "OperatorSession" ADD CONSTRAINT "OperatorSession_expiry_check" CHECK (
  "expiresAt">"createdAt" AND "expiresAt"<="createdAt"+ CASE WHEN capability='MOBILE_LIMITED' THEN interval '15 minutes' ELSE interval '30 minutes' END
);
ALTER TABLE "ActionGrant" ADD CONSTRAINT "ActionGrant_bounds_check" CHECK (
  "expectedVersion">0 AND "requestDigest" ~ '^[a-f0-9]{64}$' AND "expiresAt">"createdAt" AND "expiresAt"<="createdAt"+interval '5 minutes'
);
ALTER TABLE "OrderDeadlineExtension" ADD CONSTRAINT "OrderDeadlineExtension_bounds_check" CHECK (
  "newDeadline"="approvedAt"+interval '72 hours' AND "affectedSides" IS NOT NULL AND cardinality("affectedSides") BETWEEN 1 AND 2 AND length(reason)>0
);

CREATE FUNCTION reject_after_sales_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'After-sales history is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER "CaseRecord_immutable" BEFORE UPDATE OR DELETE ON "CaseRecord" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();
CREATE TRIGGER "CaseEvidence_immutable" BEFORE UPDATE OR DELETE ON "CaseEvidence" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();
CREATE TRIGGER "ResolutionVersion_immutable" BEFORE UPDATE OR DELETE ON "ResolutionVersion" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();
CREATE TRIGGER "ResolutionConsent_immutable" BEFORE UPDATE OR DELETE ON "ResolutionConsent" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();
CREATE TRIGGER "ResolutionApproval_immutable" BEFORE UPDATE OR DELETE ON "ResolutionApproval" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();
CREATE TRIGGER "ResolutionExecution_immutable" BEFORE UPDATE OR DELETE ON "ResolutionExecution" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();
CREATE TRIGGER "ReturnObligation_immutable" BEFORE UPDATE OR DELETE ON "ReturnObligation" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();
CREATE TRIGGER "ReturnShipmentItem_immutable" BEFORE UPDATE OR DELETE ON "ReturnShipmentItem" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();
CREATE TRIGGER "ReturnEvent_immutable" BEFORE UPDATE OR DELETE ON "ReturnEvent" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();
CREATE TRIGGER "CompensationObligation_immutable" BEFORE UPDATE OR DELETE ON "CompensationObligation" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();
CREATE TRIGGER "CompensationFinancialEntry_immutable" BEFORE UPDATE OR DELETE ON "CompensationFinancialEntry" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();
CREATE TRIGGER "RiskRecord_immutable" BEFORE UPDATE OR DELETE ON "RiskRecord" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();
CREATE TRIGGER "OrderDeadlineExtension_immutable" BEFORE UPDATE OR DELETE ON "OrderDeadlineExtension" FOR EACH ROW EXECUTE FUNCTION reject_after_sales_history_mutation();

-- Metadata is fixed; the listed progress fields live on mutable rows.
CREATE FUNCTION protect_after_sales_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_fact jsonb; new_fact jsonb; mutable_columns text[];
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'After-sales metadata is immutable' USING ERRCODE='23514'; END IF;
  mutable_columns:=string_to_array(TG_ARGV[0],',');
  old_fact:=to_jsonb(OLD)-mutable_columns; new_fact:=to_jsonb(NEW)-mutable_columns;
  IF old_fact IS DISTINCT FROM new_fact THEN RAISE EXCEPTION 'After-sales metadata is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AfterSalesCase_metadata" BEFORE UPDATE OR DELETE ON "AfterSalesCase" FOR EACH ROW EXECUTE FUNCTION protect_after_sales_metadata('status,version,currentResolutionVersion,responseSide,responseDeadline,agreementDeadline,closedAt,updatedAt');
CREATE TRIGGER "CompensationPayment_metadata" BEFORE UPDATE OR DELETE ON "CompensationPayment" FOR EACH ROW EXECUTE FUNCTION protect_after_sales_metadata('status,checkoutParams,paidAt,closedAt,refundedAt,transferredAt,updatedAt');
CREATE TRIGGER "ReturnShipment_metadata" BEFORE UPDATE OR DELETE ON "ReturnShipment" FOR EACH ROW EXECUTE FUNCTION protect_after_sales_metadata('status,collectedAt,deliveredAt,updatedAt');
CREATE TRIGGER "RiskReport_metadata" BEFORE UPDATE OR DELETE ON "RiskReport" FOR EACH ROW EXECUTE FUNCTION protect_after_sales_metadata('status,version,updatedAt');
CREATE TRIGGER "OperatorDevice_metadata" BEFORE UPDATE OR DELETE ON "OperatorDevice" FOR EACH ROW EXECUTE FUNCTION protect_after_sales_metadata('capability,status,approvedById,approvedAt,revokedAt,updatedAt');
CREATE TRIGGER "OperatorSession_metadata" BEFORE UPDATE OR DELETE ON "OperatorSession" FOR EACH ROW EXECUTE FUNCTION protect_after_sales_metadata('revokedAt');
CREATE TRIGGER "ActionGrant_metadata" BEFORE UPDATE OR DELETE ON "ActionGrant" FOR EACH ROW EXECUTE FUNCTION protect_after_sales_metadata('consumedAt');
CREATE TRIGGER "OrderHoldBlocker_metadata" BEFORE UPDATE OR DELETE ON "OrderHoldBlocker" FOR EACH ROW EXECUTE FUNCTION protect_after_sales_metadata('resolvedAt');

-- Serialize collections/dispositions on one payment; no concurrent refund and
-- transfer can both observe an empty terminal fact set.
CREATE FUNCTION check_compensation_payment_amount() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE obligation "CompensationObligation";
BEGIN
  SELECT * INTO STRICT obligation FROM "CompensationObligation" WHERE id=NEW."obligationId";
  IF NEW."amountFen"<>obligation."amountFen" OR NEW.currency<>obligation.currency THEN RAISE EXCEPTION 'Compensation payment amount conservation failed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CompensationPayment_conservation" BEFORE INSERT ON "CompensationPayment" FOR EACH ROW EXECUTE FUNCTION check_compensation_payment_amount();

CREATE FUNCTION check_compensation_financial_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment "CompensationPayment"; collected integer;
BEGIN
  SELECT * INTO STRICT payment FROM "CompensationPayment" WHERE id=NEW."paymentId" FOR UPDATE;
  IF NEW."amountFen"<>payment."amountFen" OR NEW.currency<>payment.currency OR NEW.provider<>payment.provider THEN
    RAISE EXCEPTION 'Compensation amount conservation failed' USING ERRCODE='23514';
  END IF;
  IF NEW."entryType"<>'COLLECTION' THEN
    SELECT "amountFen" INTO collected FROM "CompensationFinancialEntry" WHERE "paymentId"=NEW."paymentId" AND "entryType"='COLLECTION';
    IF collected IS NULL THEN RAISE EXCEPTION 'Disposition requires confirmed collection' USING ERRCODE='23514'; END IF;
    IF NEW."amountFen">collected THEN RAISE EXCEPTION 'Compensation amount conservation failed' USING ERRCODE='23514'; END IF;
    IF EXISTS (SELECT 1 FROM "CompensationFinancialEntry" WHERE "paymentId"=NEW."paymentId" AND "entryType" IN ('TRANSFER','REFUND')) THEN
      RAISE EXCEPTION 'Compensation already has a terminal disposition' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CompensationFinancialEntry_conservation" BEFORE INSERT ON "CompensationFinancialEntry" FOR EACH ROW EXECUTE FUNCTION check_compensation_financial_entry();
-- Unique-index conflict detection is independent of an INSERT transaction's
-- MVCC snapshot; the trigger's EXISTS alone is unsafe under REPEATABLE READ.
CREATE UNIQUE INDEX "CompensationFinancialEntry_one_terminal" ON "CompensationFinancialEntry" ("paymentId") WHERE "entryType" IN ('TRANSFER','REFUND');

-- Trust only explicit UTC completion times in the existing immutable completion
-- audit. Conflicting timestamps, malformed dates and absent evidence remain NULL.
WITH valid_audits AS (
  SELECT "entityId", (after->>'completedAt')::timestamptz AT TIME ZONE 'UTC' AS completed
  FROM "AuditLog"
  WHERE action='ORDER_COMPLETED' AND "entityType"='Order' AND after->>'status'='COMPLETED'
    AND after->>'completedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?Z$'
    AND pg_input_is_valid(after->>'completedAt','timestamp with time zone')
), unambiguous AS (
  SELECT "entityId", min(completed) AS completed FROM valid_audits GROUP BY "entityId" HAVING count(DISTINCT completed)=1
)
UPDATE "Order" o SET "completedAt"=a.completed FROM unambiguous a WHERE o.id::text=a."entityId" AND o.status='COMPLETED';

CREATE FUNCTION protect_order_completed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt")
    OR (NEW."completedAt" IS NOT NULL AND NEW.status<>'COMPLETED') THEN
    RAISE EXCEPTION 'Order completion fact is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Order_completedAt_immutable" BEFORE UPDATE ON "Order" FOR EACH ROW EXECUTE FUNCTION protect_order_completed_at();
CREATE FUNCTION validate_resolution_funds_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c jsonb:=NEW."compensationComponents"; reversal jsonb;
  component text; amount integer; reversal_amount integer; signed_net integer;
  order_id uuid; original_difference integer; plan jsonb; intent "PaymentIntent";
BEGIN
  SELECT o.id,o."differenceFen" INTO STRICT order_id,original_difference
    FROM "Order" o JOIN "AfterSalesCase" a ON a."orderId"=o.id WHERE a.id=NEW."caseId";
  IF jsonb_typeof(c) IS DISTINCT FROM 'object'
    OR NOT c ?& ARRAY['originalDifferenceReversal','initiatorExtraFen','recipientExtraFen','initiatorShippingFen','recipientShippingFen']
    OR c-ARRAY['originalDifferenceReversal','initiatorExtraFen','recipientExtraFen','initiatorShippingFen','recipientShippingFen']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid compensation components' USING ERRCODE='23514';
  END IF;
  FOREACH component IN ARRAY ARRAY['initiatorExtraFen','recipientExtraFen','initiatorShippingFen','recipientShippingFen'] LOOP
    IF jsonb_typeof(c->component) IS DISTINCT FROM 'number' OR c->>component !~ '^[0-9]+$' OR (c->>component)::numeric>20000 THEN
      RAISE EXCEPTION 'Compensation component bounds exceeded' USING ERRCODE='23514';
    END IF;
  END LOOP;
  reversal:=c->'originalDifferenceReversal';
  IF jsonb_typeof(reversal) IS DISTINCT FROM 'object' OR NOT reversal ?& ARRAY['amountFen','payer']
    OR reversal-ARRAY['amountFen','payer']<>'{}'::jsonb
    OR jsonb_typeof(reversal->'amountFen') IS DISTINCT FROM 'number' OR reversal->>'amountFen' !~ '^[0-9]+$'
    OR (reversal->>'amountFen')::numeric>original_difference
    OR jsonb_typeof(reversal->'payer') IS DISTINCT FROM 'string'
    OR reversal->>'payer' NOT IN ('NONE','INITIATOR','RECIPIENT') THEN
    RAISE EXCEPTION 'Original difference reversal component bounds exceeded' USING ERRCODE='23514';
  END IF;
  reversal_amount:=(reversal->>'amountFen')::integer;
  IF (reversal_amount=0)<>(reversal->>'payer'='NONE') THEN RAISE EXCEPTION 'Invalid reversal component payer' USING ERRCODE='23514'; END IF;
  signed_net:=reversal_amount*CASE WHEN reversal->>'payer'='RECIPIENT' THEN -1 ELSE 1 END
    +(c->>'initiatorExtraFen')::integer+(c->>'initiatorShippingFen')::integer
    -(c->>'recipientExtraFen')::integer-(c->>'recipientShippingFen')::integer;
  IF NEW."netCompensationFen"<>abs(signed_net) OR NEW."compensationPayer"::text<>(CASE WHEN signed_net=0 THEN 'NONE' WHEN signed_net>0 THEN 'INITIATOR' ELSE 'RECIPIENT' END) THEN
    RAISE EXCEPTION 'Net compensation does not match its components' USING ERRCODE='23514';
  END IF;
  FOR plan IN SELECT value FROM jsonb_array_elements(NEW."originalFunds") LOOP
    IF jsonb_typeof(plan) IS DISTINCT FROM 'object' OR NOT plan ?& ARRAY['paymentIntentId','destination']
      OR plan-ARRAY['paymentIntentId','destination']<>'{}'::jsonb
      OR jsonb_typeof(plan->'destination') IS DISTINCT FROM 'string'
      OR jsonb_typeof(plan->'paymentIntentId') IS DISTINCT FROM 'string'
      OR plan->>'destination' NOT IN ('RETAIN_FOR_EXCHANGE','REFUND_PAYER','SETTLE_BENEFICIARY')
      OR NOT pg_input_is_valid(plan->>'paymentIntentId','uuid') THEN
      RAISE EXCEPTION 'Invalid original funds destination' USING ERRCODE='23514';
    END IF;
    SELECT * INTO intent FROM "PaymentIntent" WHERE id=(plan->>'paymentIntentId')::uuid AND "orderId"=order_id;
    IF intent.id IS NULL OR (plan->>'destination'='SETTLE_BENEFICIARY' AND intent.purpose<>'DIFFERENCE') THEN
      RAISE EXCEPTION 'Invalid original funds destination or source' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(NEW."originalFunds"))<>(SELECT count(DISTINCT value->>'paymentIntentId') FROM jsonb_array_elements(NEW."originalFunds")) THEN
    RAISE EXCEPTION 'Duplicate original funds destination' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ResolutionVersion_funds_plan" BEFORE INSERT ON "ResolutionVersion" FOR EACH ROW EXECUTE FUNCTION validate_resolution_funds_plan();
-- The single net obligation is derived from one immutable resolution. A new
-- execution-step name cannot manufacture a second collection for that plan.
CREATE UNIQUE INDEX "CompensationObligation_one_net" ON "CompensationObligation" ("resolutionId") WHERE "amountFen">0;
CREATE FUNCTION validate_compensation_obligation_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resolution "ResolutionVersion"; dispute uuid; original_order "Order"; intent "PaymentIntent"; reversal jsonb;
BEGIN
  IF NEW."amountFen" NOT BETWEEN 1 AND 60000 OR NEW.currency<>'CNY' OR NEW."payerSide"=NEW."payeeSide" THEN
    RAISE EXCEPTION 'Compensation obligation violates amount check constraint' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT resolution FROM "ResolutionVersion" WHERE id=NEW."resolutionId";
  SELECT "rootDisputeId" INTO STRICT dispute FROM "AfterSalesCase" WHERE id=resolution."caseId";
  IF NEW."amountFen"<>resolution."netCompensationFen" OR NEW."payerSide"::text<>resolution."compensationPayer"::text OR NEW."rootDisputeId"<>dispute THEN
    RAISE EXCEPTION 'Compensation obligation must match its resolution amount, payer and dispute' USING ERRCODE='23514';
  END IF;
  reversal:=resolution."compensationComponents"->'originalDifferenceReversal';
  IF (reversal->>'amountFen')::integer>0 THEN
    IF NEW."originalPaymentIntentId" IS NULL THEN
      RAISE EXCEPTION 'Positive reversal requires an original settled difference payment' USING ERRCODE='23514';
    END IF;
    SELECT o.* INTO STRICT original_order FROM "Order" o JOIN "AfterSalesCase" a ON a."orderId"=o.id WHERE a.id=resolution."caseId";
    SELECT * INTO intent FROM "PaymentIntent" WHERE id=NEW."originalPaymentIntentId";
    IF intent.id IS NULL OR intent."orderId"<>original_order.id OR intent.purpose<>'DIFFERENCE'
      OR intent.side::text<>original_order.payer::text OR intent."amountFen"<>original_order."differenceFen"
      OR intent.currency<>'CNY' OR intent.status<>'PAID' OR intent."paidAt" IS NULL
      OR intent."closedAt" IS NOT NULL OR intent."refundedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid original settled difference payment source' USING ERRCODE='23514';
    END IF;
    -- A mutable PAID status alone cannot establish collection or settlement.
    -- Match the immutable financial facts exactly as normal settlement does.
    IF NOT EXISTS (SELECT 1 FROM "FinancialEntry" e WHERE e."intentId"=intent.id AND e."entryType"='PAYMENT'
        AND e."amountFen"=intent."amountFen" AND e.currency=intent.currency AND e.provider=intent.provider AND e."businessNo"=intent."businessNo")
      OR NOT EXISTS (SELECT 1 FROM "FinancialEntry" e WHERE e."intentId"=intent.id AND e."entryType"='DIFFERENCE_SETTLEMENT'
        AND e."amountFen"=intent."amountFen" AND e.currency=intent.currency AND e.provider=intent.provider AND e."businessNo"='settle:'||intent.id::text) THEN
      RAISE EXCEPTION 'Original difference payment lacks confirmed collection or settlement' USING ERRCODE='23514';
    END IF;
    -- The reversal component returns money from the original beneficiary to
    -- the original payer. Offsetting extras may give the net another payer.
    IF reversal->>'payer'<>(CASE WHEN intent.side='INITIATOR' THEN 'RECIPIENT' ELSE 'INITIATOR' END) THEN
      RAISE EXCEPTION 'Original difference reversal direction must return to its original payer' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CompensationObligation_source" BEFORE INSERT ON "CompensationObligation" FOR EACH ROW EXECUTE FUNCTION validate_compensation_obligation_source();
