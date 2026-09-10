UPDATE "contactFact"
SET "linkCheckedAt" = NULL
WHERE "field" = 'employer'
  AND "status" = 'APPLIED'::"FactStatus";
