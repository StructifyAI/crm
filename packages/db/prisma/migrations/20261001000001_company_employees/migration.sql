ALTER TABLE "company" ADD COLUMN "employeeCount" INTEGER,
ADD COLUMN "employeeRange" TEXT;

UPDATE "company" c SET
  "employeeCount" = CASE WHEN e.raw->'brand'->'employees'->>'exact' ~ '^[0-9]+$' THEN (e.raw->'brand'->'employees'->>'exact')::int END,
  "employeeRange" = NULLIF(btrim(e.raw->'brand'->'employees'->>'range'), '')
FROM "companyEnrichment" e
WHERE e."companyId" = c.id AND jsonb_typeof(e.raw->'brand'->'employees') = 'object';
