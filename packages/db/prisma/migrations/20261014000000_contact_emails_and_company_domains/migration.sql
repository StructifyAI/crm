CREATE TYPE "ContactEmailStatus" AS ENUM ('OK', 'BOUNCED');

ALTER TABLE "contact"
ADD COLUMN "emailStatus" "ContactEmailStatus" NOT NULL DEFAULT 'OK';

CREATE TABLE "contactEmail" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "ContactEmailStatus" NOT NULL DEFAULT 'OK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contactEmail_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "companyDomain" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "companyDomain_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contactEmail_contactId_email_key" ON "contactEmail"("contactId", "email");
CREATE INDEX "contactEmail_email_idx" ON "contactEmail"("email");
CREATE UNIQUE INDEX "companyDomain_companyId_domain_key" ON "companyDomain"("companyId", "domain");
CREATE INDEX "companyDomain_domain_idx" ON "companyDomain"("domain");

ALTER TABLE "contactEmail"
ADD CONSTRAINT "contactEmail_contactId_fkey"
FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "companyDomain"
ADD CONSTRAINT "companyDomain_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
