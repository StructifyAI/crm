CREATE INDEX "contact_email_lower_idx" ON "contact" (lower("email")) WHERE "archivedAt" IS NULL;
CREATE INDEX "contactEmail_email_lower_idx" ON "contactEmail" (lower("email"));
CREATE INDEX "contact_linkedin_slug_idx" ON "contact" ((lower(substring("linkedinUrl" from '/in/([^/?#]+)')))) WHERE "archivedAt" IS NULL;
CREATE INDEX "contact_linkedin_trailing_id_idx" ON "contact" ((substring(lower(substring("linkedinUrl" from '/in/([^/?#]+)')) from '[^-]+$'))) WHERE "archivedAt" IS NULL;
