ALTER TABLE "company" ADD COLUMN "icp" TEXT NOT NULL DEFAULT 'Unknown';

CREATE INDEX "company_icp_idx" ON "company"("icp");
