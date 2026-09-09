ALTER TYPE "RecordSource" ADD VALUE 'INSTANTLY';

ALTER TABLE "appSetting"
ADD COLUMN "instantlyWebhookSecret" TEXT,
ADD COLUMN "instantlyLastEventAt" TIMESTAMP(3);

CREATE TABLE "instantlyMailbox" (
    "id" TEXT NOT NULL,
    "emailAccount" TEXT NOT NULL,
    "ownerId" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instantlyMailbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "instantlyMailbox_emailAccount_key" ON "instantlyMailbox"("emailAccount");

ALTER TABLE "instantlyMailbox"
ADD CONSTRAINT "instantlyMailbox_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
