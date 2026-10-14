CREATE TYPE "DuplicateKind" AS ENUM ('CONTACT', 'COMPANY');

CREATE TYPE "DuplicateStatus" AS ENUM ('OPEN', 'MERGED', 'DISMISSED');

ALTER TABLE "appSetting"
ADD COLUMN "duplicateContactCursor" TEXT,
ADD COLUMN "duplicateCompanyCursor" TEXT,
ADD COLUMN "duplicateContactsComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "duplicateCompaniesComplete" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "duplicateCandidate" (
    "id" TEXT NOT NULL,
    "kind" "DuplicateKind" NOT NULL,
    "aId" TEXT NOT NULL,
    "bId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DuplicateStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "duplicateCandidate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "duplicateCandidate_ordered_pair_check" CHECK ("aId" < "bId"),
    CONSTRAINT "duplicateCandidate_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "duplicateCandidate_kind_aId_bId_key"
ON "duplicateCandidate"("kind", "aId", "bId");

CREATE INDEX "duplicateCandidate_status_kind_idx"
ON "duplicateCandidate"("status", "kind");
