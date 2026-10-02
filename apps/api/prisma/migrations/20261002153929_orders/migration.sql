-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('AWAITING_DETAILS', 'AWAITING_PAYMENT', 'AWAITING_FULFILLMENT', 'IN_TRANSIT', 'AWAITING_ACCEPTANCE', 'SETTLING', 'COMPLETED', 'CANCEL_PENDING', 'CANCELLED', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('INITIATOR', 'RECIPIENT');

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('DEPOSIT', 'DIFFERENCE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'PAID', 'CLOSED', 'REFUNDED', 'UNKNOWN', 'FAILED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('REGISTERED', 'COLLECTED', 'DELIVERED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "OrderCancellationStatus" AS ENUM ('REQUESTED', 'AGREED', 'REJECTED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "FinancialEntryType" AS ENUM ('PAYMENT', 'REFUND', 'DIFFERENCE_SETTLEMENT');

-- CreateEnum
CREATE TYPE "IntegrationOperationKind" AS ENUM ('CREATE_PAYMENT', 'CLOSE_PAYMENT', 'REFUND_PAYMENT', 'SETTLE_DIFFERENCE', 'VERIFY_SHIPMENT', 'QUERY_SHIPMENT');

-- CreateEnum
CREATE TYPE "IntegrationEventKind" AS ENUM ('PAYMENT_SUCCEEDED', 'PAYMENT_CLOSED', 'REFUND_SUCCEEDED', 'DIFFERENCE_SETTLED', 'SHIPMENT_PROGRESS');

-- CreateEnum
CREATE TYPE "IntegrationReceiptStatus" AS ENUM ('PENDING', 'PROCESSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'UNKNOWN', 'FAILED');

-- CreateEnum
CREATE TYPE "ProviderResultStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILURE', 'UNKNOWN');

-- AlterEnum
ALTER TYPE "ProposalStatus" ADD VALUE 'CONVERTED';

-- AlterTable
ALTER TABLE "ItemReservation" ADD COLUMN     "orderId" UUID,
ALTER COLUMN "proposalId" DROP NOT NULL,
ALTER COLUMN "proposalVersionId" DROP NOT NULL,
ALTER COLUMN "expiresAt" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "proposalId" UUID NOT NULL,
    "proposalVersionId" UUID NOT NULL,
    "initiatorId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "rulesVersion" TEXT NOT NULL,
    "depositFen" INTEGER NOT NULL,
    "feeFen" INTEGER NOT NULL,
    "detailsHours" INTEGER NOT NULL,
    "paymentHours" INTEGER NOT NULL,
    "fulfillmentHours" INTEGER NOT NULL,
    "inspectionHours" INTEGER NOT NULL,
    "differenceFen" INTEGER NOT NULL,
    "payer" "ProposalPayer" NOT NULL,
    "deliveryMode" "DeliveryMode" NOT NULL,
    "initiatorShippingFen" INTEGER NOT NULL,
    "recipientShippingFen" INTEGER NOT NULL,
    "simulation" BOOLEAN NOT NULL,
    "detailsDeadline" TIMESTAMP(3),
    "paymentDeadline" TIMESTAMP(3),
    "fulfillmentDeadline" TIMESTAMP(3),
    "holdReason" TEXT,
    "holdPreviousStatus" "OrderStatus",
    "heldAt" TIMESTAMP(3),
    "outstandingObligations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItemSnapshot" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "itemVersion" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "referenceValueFen" INTEGER NOT NULL,
    "condition" "ItemCondition" NOT NULL,
    "wantedText" TEXT NOT NULL,
    "imageUrls" TEXT[],

    CONSTRAINT "OrderItemSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderPartyProgress" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "addressReady" BOOLEAN NOT NULL DEFAULT false,
    "fundsReady" BOOLEAN NOT NULL DEFAULT false,
    "handedOverAt" TIMESTAMP(3),
    "incomingDeliveredAt" TIMESTAMP(3),
    "acceptanceDeadline" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "OrderPartyProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAddress" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "keyVersion" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "frozenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL,
    "amountFen" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "businessNo" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "externalTransactionId" TEXT,
    "checkoutParams" JSONB,
    "paidAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationEvent" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" "IntegrationEventKind" NOT NULL,
    "businessNo" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "externalTransactionId" TEXT,
    "amountFen" INTEGER,
    "currency" TEXT,
    "shipmentId" UUID,
    "progress" "ShipmentStatus",
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationEventReceipt" (
    "eventId" UUID NOT NULL,
    "status" "IntegrationReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "processedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationEventReceipt_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "FinancialEntry" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "integrationEventId" UUID NOT NULL,
    "entryType" "FinancialEntryType" NOT NULL,
    "provider" TEXT NOT NULL,
    "externalTransactionId" TEXT NOT NULL,
    "businessNo" TEXT NOT NULL,
    "amountFen" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "carrier" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "businessNo" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'REGISTERED',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collectedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentEvent" (
    "id" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "integrationEventId" UUID NOT NULL,
    "progress" "ShipmentStatus" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderCancellation" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "requestedBySide" "OrderSide" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "OrderCancellationStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedVersion" INTEGER NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "OrderCancellation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxCommand" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "businessNo" TEXT NOT NULL,
    "kind" "IntegrationOperationKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulatedProviderOperation" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "businessNo" TEXT NOT NULL,
    "orderId" UUID NOT NULL,
    "kind" "IntegrationOperationKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ProviderResultStatus" NOT NULL DEFAULT 'PENDING',
    "externalTransactionId" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SimulatedProviderOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_proposalId_key" ON "Order"("proposalId");

-- CreateIndex
CREATE INDEX "Order_initiatorId_createdAt_id_idx" ON "Order"("initiatorId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Order_recipientId_createdAt_id_idx" ON "Order"("recipientId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Order_status_detailsDeadline_idx" ON "Order"("status", "detailsDeadline");

-- CreateIndex
CREATE INDEX "Order_status_paymentDeadline_idx" ON "Order"("status", "paymentDeadline");

-- CreateIndex
CREATE INDEX "Order_status_fulfillmentDeadline_idx" ON "Order"("status", "fulfillmentDeadline");

-- CreateIndex
CREATE INDEX "OrderItemSnapshot_itemId_idx" ON "OrderItemSnapshot"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItemSnapshot_orderId_itemId_key" ON "OrderItemSnapshot"("orderId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItemSnapshot_orderId_side_sortOrder_key" ON "OrderItemSnapshot"("orderId", "side", "sortOrder");

-- CreateIndex
CREATE INDEX "OrderPartyProgress_acceptanceDeadline_idx" ON "OrderPartyProgress"("acceptanceDeadline");

-- CreateIndex
CREATE UNIQUE INDEX "OrderPartyProgress_orderId_side_key" ON "OrderPartyProgress"("orderId", "side");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAddress_orderId_side_key" ON "OrderAddress"("orderId", "side");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_businessNo_key" ON "PaymentIntent"("businessNo");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_orderId_side_purpose_key" ON "PaymentIntent"("orderId", "side", "purpose");

-- CreateIndex
CREATE INDEX "IntegrationEvent_businessNo_idx" ON "IntegrationEvent"("businessNo");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationEvent_provider_eventId_key" ON "IntegrationEvent"("provider", "eventId");

-- CreateIndex
CREATE INDEX "IntegrationEventReceipt_status_updatedAt_idx" ON "IntegrationEventReceipt"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialEntry_businessNo_key" ON "FinancialEntry"("businessNo");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialEntry_intentId_entryType_key" ON "FinancialEntry"("intentId", "entryType");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialEntry_provider_externalTransactionId_entryType_key" ON "FinancialEntry"("provider", "externalTransactionId", "entryType");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_businessNo_key" ON "Shipment"("businessNo");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_orderId_side_key" ON "Shipment"("orderId", "side");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_carrier_trackingNumber_key" ON "Shipment"("carrier", "trackingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentEvent_integrationEventId_key" ON "ShipmentEvent"("integrationEventId");

-- CreateIndex
CREATE INDEX "ShipmentEvent_shipmentId_occurredAt_idx" ON "ShipmentEvent"("shipmentId", "occurredAt");

-- CreateIndex
CREATE INDEX "OrderCancellation_orderId_requestedAt_idx" ON "OrderCancellation"("orderId", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxCommand_businessNo_key" ON "OutboxCommand"("businessNo");

-- CreateIndex
CREATE INDEX "OutboxCommand_status_availableAt_idx" ON "OutboxCommand"("status", "availableAt");

-- CreateIndex
CREATE INDEX "OutboxCommand_status_leaseExpiresAt_idx" ON "OutboxCommand"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SimulatedProviderOperation_businessNo_key" ON "SimulatedProviderOperation"("businessNo");

-- CreateIndex
CREATE INDEX "SimulatedProviderOperation_orderId_idx" ON "SimulatedProviderOperation"("orderId");

-- CreateIndex
CREATE INDEX "ItemReservation_orderId_idx" ON "ItemReservation"("orderId");

-- AddForeignKey
ALTER TABLE "ItemReservation" ADD CONSTRAINT "ItemReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_proposalVersionId_fkey" FOREIGN KEY ("proposalVersionId") REFERENCES "ProposalVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemSnapshot" ADD CONSTRAINT "OrderItemSnapshot_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemSnapshot" ADD CONSTRAINT "OrderItemSnapshot_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPartyProgress" ADD CONSTRAINT "OrderPartyProgress_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAddress" ADD CONSTRAINT "OrderAddress_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationEventReceipt" ADD CONSTRAINT "IntegrationEventReceipt_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "IntegrationEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialEntry" ADD CONSTRAINT "FinancialEntry_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialEntry" ADD CONSTRAINT "FinancialEntry_integrationEventId_fkey" FOREIGN KEY ("integrationEventId") REFERENCES "IntegrationEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_integrationEventId_fkey" FOREIGN KEY ("integrationEventId") REFERENCES "IntegrationEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCancellation" ADD CONSTRAINT "OrderCancellation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxCommand" ADD CONSTRAINT "OutboxCommand_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing proposal leases keep their primary keys and all original values.
ALTER TABLE "ItemReservation" ADD CONSTRAINT "ItemReservation_owner_check" CHECK (
  ("orderId" IS NULL AND "proposalId" IS NOT NULL AND "proposalVersionId" IS NOT NULL AND "expiresAt" IS NOT NULL)
  OR ("orderId" IS NOT NULL AND "proposalId" IS NULL AND "proposalVersionId" IS NULL AND "expiresAt" IS NULL)
);
ALTER TABLE "Order" ADD CONSTRAINT "Order_participants_check" CHECK ("initiatorId" <> "recipientId");
ALTER TABLE "Order" ADD CONSTRAINT "Order_bounds_check" CHECK (
  "version" > 0 AND "depositFen" >= 0 AND "feeFen" >= 0 AND "detailsHours" > 0
  AND "paymentHours" > 0 AND "fulfillmentHours" > 0 AND "inspectionHours" > 0
  AND "differenceFen" BETWEEN 0 AND 20000 AND "initiatorShippingFen" >= 0 AND "recipientShippingFen" >= 0
  AND (("differenceFen" = 0 AND "payer" = 'NONE') OR ("differenceFen" > 0 AND "payer" <> 'NONE'))
  AND ("deliveryMode" <> 'IN_PERSON' OR ("initiatorShippingFen" = 0 AND "recipientShippingFen" = 0))
);
ALTER TABLE "OrderItemSnapshot" ADD CONSTRAINT "OrderItemSnapshot_bounds_check" CHECK (
  "itemVersion" > 0 AND "referenceValueFen" BETWEEN 100 AND 1000000
  AND "imageUrls" IS NOT NULL AND cardinality("imageUrls") BETWEEN 3 AND 9
  AND (("side" = 'INITIATOR' AND "sortOrder" BETWEEN 0 AND 4) OR ("side" = 'RECIPIENT' AND "sortOrder" = 0))
);
ALTER TABLE "OrderAddress" ADD CONSTRAINT "OrderAddress_encryption_check" CHECK (
  "version" > 0 AND octet_length("nonce") = 12 AND octet_length("tag") = 16 AND octet_length("ciphertext") > 0
);
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_amount_check" CHECK ("amountFen" > 0 AND "currency" = 'CNY');
ALTER TABLE "FinancialEntry" ADD CONSTRAINT "FinancialEntry_amount_check" CHECK ("amountFen" > 0 AND "currency" = 'CNY');
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_amount_check" CHECK ("amountFen" IS NULL OR "amountFen" > 0);
ALTER TABLE "OrderCancellation" ADD CONSTRAINT "OrderCancellation_version_check" CHECK ("requestedVersion" > 0);
ALTER TABLE "OutboxCommand" ADD CONSTRAINT "OutboxCommand_attempts_check" CHECK ("attempts" >= 0);
CREATE UNIQUE INDEX "OrderCancellation_one_requested" ON "OrderCancellation" ("orderId") WHERE "status" = 'REQUESTED';

CREATE FUNCTION reject_order_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Order history is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "OrderItemSnapshot_immutable" BEFORE UPDATE OR DELETE ON "OrderItemSnapshot"
  FOR EACH ROW EXECUTE FUNCTION reject_order_history_mutation();
CREATE TRIGGER "FinancialEntry_immutable" BEFORE UPDATE OR DELETE ON "FinancialEntry"
  FOR EACH ROW EXECUTE FUNCTION reject_order_history_mutation();
CREATE TRIGGER "ShipmentEvent_immutable" BEFORE UPDATE OR DELETE ON "ShipmentEvent"
  FOR EACH ROW EXECUTE FUNCTION reject_order_history_mutation();
CREATE TRIGGER "IntegrationEvent_immutable" BEFORE UPDATE OR DELETE ON "IntegrationEvent"
  FOR EACH ROW EXECUTE FUNCTION reject_order_history_mutation();
CREATE TRIGGER "AuditLog_immutable" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION reject_order_history_mutation();

-- Progress columns can change. Sources, identities, rules and agreed terms cannot.
CREATE FUNCTION protect_order_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Order history is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."id",NEW."proposalId",NEW."proposalVersionId",NEW."initiatorId",NEW."recipientId",NEW."rulesVersion",
    NEW."depositFen",NEW."feeFen",NEW."detailsHours",NEW."paymentHours",NEW."fulfillmentHours",NEW."inspectionHours",
    NEW."differenceFen",NEW."payer",NEW."deliveryMode",NEW."initiatorShippingFen",NEW."recipientShippingFen",NEW."simulation",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id",OLD."proposalId",OLD."proposalVersionId",OLD."initiatorId",OLD."recipientId",OLD."rulesVersion",
    OLD."depositFen",OLD."feeFen",OLD."detailsHours",OLD."paymentHours",OLD."fulfillmentHours",OLD."inspectionHours",
    OLD."differenceFen",OLD."payer",OLD."deliveryMode",OLD."initiatorShippingFen",OLD."recipientShippingFen",OLD."simulation",OLD."createdAt") THEN
    RAISE EXCEPTION 'Order snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Order_snapshot_immutable" BEFORE UPDATE OR DELETE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION protect_order_snapshot();

CREATE FUNCTION protect_payment_obligation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payment obligation is immutable' USING ERRCODE = '23514'; END IF;
  IF ROW(NEW."id",NEW."orderId",NEW."side",NEW."purpose",NEW."amountFen",NEW."currency",NEW."businessNo",NEW."provider",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id",OLD."orderId",OLD."side",OLD."purpose",OLD."amountFen",OLD."currency",OLD."businessNo",OLD."provider",OLD."createdAt") THEN
    RAISE EXCEPTION 'Payment obligation is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PaymentIntent_obligation_immutable" BEFORE UPDATE OR DELETE ON "PaymentIntent"
  FOR EACH ROW EXECUTE FUNCTION protect_payment_obligation();

CREATE FUNCTION protect_cancellation_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Cancellation history is immutable' USING ERRCODE = '23514'; END IF;
  IF ROW(NEW."id",NEW."orderId",NEW."requestedBySide",NEW."reason",NEW."requestedVersion",NEW."requestedAt")
    IS DISTINCT FROM ROW(OLD."id",OLD."orderId",OLD."requestedBySide",OLD."reason",OLD."requestedVersion",OLD."requestedAt")
    OR (OLD."status" <> 'REQUESTED' AND ROW(NEW."status",NEW."respondedAt") IS DISTINCT FROM ROW(OLD."status",OLD."respondedAt")) THEN
    RAISE EXCEPTION 'Cancellation history is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrderCancellation_history_immutable" BEFORE UPDATE OR DELETE ON "OrderCancellation"
  FOR EACH ROW EXECUTE FUNCTION protect_cancellation_history();
