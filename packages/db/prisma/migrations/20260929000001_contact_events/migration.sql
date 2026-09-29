-- CreateEnum
CREATE TYPE "EmailClassification" AS ENUM ('OURS', 'THEIRS', 'INTERNAL', 'AUTOMATED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ContactDirection" AS ENUM ('OUT', 'IN');

-- CreateEnum
CREATE TYPE "ContactChannel" AS ENUM ('EMAIL', 'CALL', 'MEETING', 'LINKEDIN', 'TEXT', 'VOICEMAIL', 'IN_PERSON', 'OTHER');

-- CreateEnum
CREATE TYPE "ContactDatePrecision" AS ENUM ('EXACT', 'DAY', 'MONTH', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ContactEventOrigin" AS ENUM ('RECORDED', 'EXTRACTED');

-- CreateEnum
CREATE TYPE "ContactExtractionStatus" AS ENUM ('DONE', 'FAILED');

-- AlterTable
ALTER TABLE "activity" ADD COLUMN     "direction" "ContactDirection";

-- AlterTable
ALTER TABLE "company" ADD COLUMN     "lastContactedAt" TIMESTAMP(3),
ADD COLUMN     "lastContactedEventId" TEXT,
ADD COLUMN     "lastRepliedAt" TIMESTAMP(3),
ADD COLUMN     "lastRepliedEventId" TEXT;

-- AlterTable
ALTER TABLE "contact" ADD COLUMN     "lastContactedAt" TIMESTAMP(3),
ADD COLUMN     "lastContactedEventId" TEXT,
ADD COLUMN     "lastRepliedAt" TIMESTAMP(3),
ADD COLUMN     "lastRepliedEventId" TEXT;

-- AlterTable
ALTER TABLE "deal" ADD COLUMN     "lastContactedAt" TIMESTAMP(3),
ADD COLUMN     "lastContactedEventId" TEXT,
ADD COLUMN     "lastRepliedAt" TIMESTAMP(3),
ADD COLUMN     "lastRepliedEventId" TEXT;

-- AlterTable
ALTER TABLE "emailMessage" ADD COLUMN     "classification" "EmailClassification";

-- CreateTable
CREATE TABLE "contactEvent" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "dealId" TEXT,
    "contactId" TEXT,
    "companyId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "datePrecision" "ContactDatePrecision" NOT NULL,
    "channel" "ContactChannel" NOT NULL,
    "direction" "ContactDirection" NOT NULL,
    "origin" "ContactEventOrigin" NOT NULL,
    "sourceActivityId" TEXT,
    "sourceMessageId" TEXT,
    "bodyHash" TEXT,
    "confidence" DOUBLE PRECISION,
    "verification" DOUBLE PRECISION,
    "quote" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contactEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contactExtraction" (
    "activityId" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "status" "ContactExtractionStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "model" TEXT,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contactExtraction_pkey" PRIMARY KEY ("activityId")
);

-- CreateIndex
CREATE UNIQUE INDEX "contactEvent_sourceKey_key" ON "contactEvent"("sourceKey");

-- CreateIndex
CREATE INDEX "contactEvent_dealId_idx" ON "contactEvent"("dealId");

-- CreateIndex
CREATE INDEX "contactEvent_contactId_idx" ON "contactEvent"("contactId");

-- CreateIndex
CREATE INDEX "contactEvent_companyId_idx" ON "contactEvent"("companyId");

-- CreateIndex
CREATE INDEX "contactEvent_sourceActivityId_idx" ON "contactEvent"("sourceActivityId");

-- CreateIndex
CREATE INDEX "contactEvent_needsReview_idx" ON "contactEvent"("needsReview");

-- CreateIndex
CREATE INDEX "company_lastContactedAt_idx" ON "company"("lastContactedAt");

-- CreateIndex
CREATE INDEX "company_lastRepliedAt_idx" ON "company"("lastRepliedAt");

-- CreateIndex
CREATE INDEX "contact_lastContactedAt_idx" ON "contact"("lastContactedAt");

-- CreateIndex
CREATE INDEX "contact_lastRepliedAt_idx" ON "contact"("lastRepliedAt");

-- CreateIndex
CREATE INDEX "deal_lastContactedAt_idx" ON "deal"("lastContactedAt");

-- CreateIndex
CREATE INDEX "deal_lastRepliedAt_idx" ON "deal"("lastRepliedAt");

-- AddForeignKey
ALTER TABLE "company" ADD CONSTRAINT "company_lastContactedEventId_fkey" FOREIGN KEY ("lastContactedEventId") REFERENCES "contactEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company" ADD CONSTRAINT "company_lastRepliedEventId_fkey" FOREIGN KEY ("lastRepliedEventId") REFERENCES "contactEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_lastContactedEventId_fkey" FOREIGN KEY ("lastContactedEventId") REFERENCES "contactEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_lastRepliedEventId_fkey" FOREIGN KEY ("lastRepliedEventId") REFERENCES "contactEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_lastContactedEventId_fkey" FOREIGN KEY ("lastContactedEventId") REFERENCES "contactEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_lastRepliedEventId_fkey" FOREIGN KEY ("lastRepliedEventId") REFERENCES "contactEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contactEvent" ADD CONSTRAINT "contactEvent_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contactEvent" ADD CONSTRAINT "contactEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contactEvent" ADD CONSTRAINT "contactEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contactEvent" ADD CONSTRAINT "contactEvent_sourceActivityId_fkey" FOREIGN KEY ("sourceActivityId") REFERENCES "activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contactEvent" ADD CONSTRAINT "contactEvent_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "emailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contactExtraction" ADD CONSTRAINT "contactExtraction_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
