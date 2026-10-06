CREATE TABLE "extrovertListSync" (
    "listId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "previousUrls" JSONB NOT NULL DEFAULT '[]',
    "skippedUrls" JSONB NOT NULL DEFAULT '[]',
    "cycle" JSONB,
    "lastCycleStartedAt" TIMESTAMP(3),
    "lastCycleFinishedAt" TIMESTAMP(3),
    "lastSummary" TEXT,
    "lastError" TEXT,
    "alert" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extrovertListSync_pkey" PRIMARY KEY ("listId")
);

INSERT INTO "extrovertListSync" ("listId", "enabled", "updatedAt")
VALUES ('2f6e84ed-e33e-4d54-bb83-91c0fd3d579f', false, CURRENT_TIMESTAMP);
