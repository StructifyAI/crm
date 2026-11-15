ALTER TABLE "mailboxSync" ADD COLUMN "lastReconciledAt" TIMESTAMP(3);
ALTER TABLE "mailboxSync" ADD COLUMN "reconcileCursor" TEXT;
