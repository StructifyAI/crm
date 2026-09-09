ALTER TABLE "appSetting"
ADD COLUMN "instantlyApiKey" TEXT,
ADD COLUMN "instantlyLastSyncAt" TIMESTAMP(3),
ADD COLUMN "instantlySyncError" TEXT;

CREATE TABLE "instantlyCampaignLead" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "interestStatus" INTEGER,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "stepIndex" INTEGER,
    "stepCount" INTEGER,
    "sendingMailbox" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "nextContactAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instantlyCampaignLead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "instantlyCampaignLead_leadId_key" ON "instantlyCampaignLead"("leadId");
CREATE UNIQUE INDEX "instantlyCampaignLead_contactId_campaignId_key" ON "instantlyCampaignLead"("contactId", "campaignId");

ALTER TABLE "instantlyCampaignLead"
ADD CONSTRAINT "instantlyCampaignLead_contactId_fkey"
FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
