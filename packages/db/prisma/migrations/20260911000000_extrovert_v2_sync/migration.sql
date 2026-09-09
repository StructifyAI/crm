ALTER TABLE "appSetting"
ADD COLUMN "extrovertSyncResume" JSONB,
ADD COLUMN "extrovertConnectionFieldId" TEXT;

ALTER TABLE "extrovertProspect"
ALTER COLUMN "campaignId" DROP NOT NULL,
ALTER COLUMN "campaignName" DROP NOT NULL,
ADD COLUMN "connectedMemberId" TEXT,
ADD COLUMN "lastSeenAt" TIMESTAMP(3);

UPDATE "extrovertProspect"
SET "lastSeenAt" = COALESCE("updatedAt", CURRENT_TIMESTAMP)
WHERE "lastSeenAt" IS NULL;

ALTER TABLE "extrovertProspect"
ALTER COLUMN "lastSeenAt" SET NOT NULL,
DROP COLUMN "lastCommentAt";

CREATE INDEX "extrovertProspect_connectedMemberId_idx"
ON "extrovertProspect"("connectedMemberId");

CREATE INDEX "extrovertProspect_lastSeenAt_idx"
ON "extrovertProspect"("lastSeenAt");

ALTER TABLE "appSetting"
ADD CONSTRAINT "appSetting_extrovertConnectionFieldId_fkey"
FOREIGN KEY ("extrovertConnectionFieldId") REFERENCES "fieldDefinition"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "extrovertProspect"
ADD CONSTRAINT "extrovertProspect_connectedMemberId_fkey"
FOREIGN KEY ("connectedMemberId") REFERENCES "extrovertMember"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
