ALTER TYPE "RecordSource" ADD VALUE 'EXTROVERT';

ALTER TABLE "appSetting"
ADD COLUMN "extrovertApiKey" TEXT,
ADD COLUMN "extrovertWebhookSecret" TEXT,
ADD COLUMN "extrovertLastEventAt" TIMESTAMP(3),
ADD COLUMN "extrovertLastSyncAt" TIMESTAMP(3),
ADD COLUMN "extrovertLastSyncError" TEXT;

CREATE TABLE "extrovertMember" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "linkedinUrl" TEXT,
    "ownerId" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extrovertMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "extrovertProspect" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignName" TEXT NOT NULL,
    "listName" TEXT,
    "memberId" TEXT,
    "directComments" INTEGER NOT NULL,
    "indirectComments" INTEGER NOT NULL,
    "likes" INTEGER NOT NULL,
    "lastCommentAt" TIMESTAMP(3),
    "connectionStatus" TEXT,
    "connectedDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extrovertProspect_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "extrovertProspect_contactId_idx" ON "extrovertProspect"("contactId");

ALTER TABLE "extrovertMember"
ADD CONSTRAINT "extrovertMember_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "extrovertProspect"
ADD CONSTRAINT "extrovertProspect_contactId_fkey"
FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
