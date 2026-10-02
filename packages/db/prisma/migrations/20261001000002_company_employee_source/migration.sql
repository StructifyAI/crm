CREATE TYPE "EmployeeSource" AS ENUM ('CONTEXT_DEV', 'WEB_SEARCH', 'IMPORT');

ALTER TABLE "company"
  ADD COLUMN "employeeSource" "EmployeeSource",
  ADD COLUMN "employeeSourceUrl" TEXT,
  ADD COLUMN "employeeCheckedAt" TIMESTAMP(3);

UPDATE "company"
SET "employeeSource" = 'CONTEXT_DEV'
WHERE "employeeCount" IS NOT NULL OR "employeeRange" IS NOT NULL;

WITH headcount AS (
  SELECT fv."companyId", replace(btrim(fv.text), ',', '') AS t
  FROM "fieldValue" fv
  JOIN "fieldDefinition" fd ON fd.id = fv."fieldId"
  WHERE fd.entity = 'COMPANY'
    AND fd.key = 'headcount'
    AND fv."companyId" IS NOT NULL
    AND fv.text IS NOT NULL
), parsed AS (
  SELECT
    "companyId",
    CASE
      WHEN t ~ '^~?[0-9]{1,7}$' AND ltrim(t, '~')::int > 0 THEN ltrim(t, '~')::int
    END AS employee_count,
    CASE
      WHEN t ~ '^[0-9]{1,7}\s*(-|–|to)\s*[0-9]{1,7}$'
        THEN regexp_replace(t, '^([0-9]+)\s*(-|–|to)\s*([0-9]+)$', '\1 to \3')
      WHEN t ~ '^[0-9]{1,7}\+$' THEN t
    END AS employee_range
  FROM headcount
)
UPDATE "company" c
SET
  "employeeCount" = p.employee_count,
  "employeeRange" = p.employee_range,
  "employeeSource" = 'IMPORT'
FROM parsed p
WHERE p."companyId" = c.id
  AND c."employeeCount" IS NULL
  AND c."employeeRange" IS NULL
  AND (p.employee_count IS NOT NULL OR p.employee_range IS NOT NULL);

UPDATE "fieldDefinition"
SET "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
WHERE entity = 'COMPANY'
  AND key = 'headcount'
  AND "archivedAt" IS NULL;
