-- AlterEnum
ALTER TYPE "FieldType" ADD VALUE 'MULTI_SELECT';

-- CreateTable
CREATE TABLE "fieldValueOption" (
    "fieldValueId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,

    CONSTRAINT "fieldValueOption_pkey" PRIMARY KEY ("fieldValueId","optionId")
);

-- CreateIndex
CREATE INDEX "fieldValueOption_optionId_idx" ON "fieldValueOption"("optionId");

-- AddForeignKey
ALTER TABLE "fieldValueOption" ADD CONSTRAINT "fieldValueOption_fieldValueId_fkey" FOREIGN KEY ("fieldValueId") REFERENCES "fieldValue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fieldValueOption" ADD CONSTRAINT "fieldValueOption_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "fieldOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
