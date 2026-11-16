CREATE TABLE "linkedinAdsCampaignDay" (
    "campaignUrn" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "campaignName" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "spendUsd" DECIMAL(12,2) NOT NULL,
    "conversions" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linkedinAdsCampaignDay_pkey" PRIMARY KEY ("campaignUrn","date")
);

CREATE INDEX "linkedinAdsCampaignDay_date_idx" ON "linkedinAdsCampaignDay"("date");
