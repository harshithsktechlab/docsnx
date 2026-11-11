-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0096 — Resume / CV sub-categories                                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A resume had no category to land in, so the scanner filed it under
-- `other/uncategorized` with no holder. Adds `employment/resume_cv` (personal)
-- and `biz_hr/resumes_cvs` (business), and moves each module's `other` after it.
-- Field specs are written by scripts/seed_document_category_fields.ts, which
-- `npm run migrate` runs next.
INSERT INTO "document_categories"
  ("module_no","module_key","module_name","document_key","document_name","sort_order","is_system","is_active")
SELECT v.module_no, v.module_key, v.module_name, v.document_key, v.document_name, v.sort_order, true, true
FROM (VALUES
  (7,'employment','Employment','resume_cv','Resume / CV',7005),
  (108,'biz_hr','Human Resources','resumes_cvs','Resumes / CVs',108008)
) AS v(module_no, module_key, module_name, document_key, document_name, sort_order)
ON CONFLICT ("module_key","document_key") DO NOTHING;
--> statement-breakpoint
UPDATE "document_categories"
   SET "sort_order" = 7006, "updated_at" = now()
 WHERE "module_key" = 'employment' AND "document_key" = 'other';
--> statement-breakpoint
UPDATE "document_categories"
   SET "sort_order" = 108009, "updated_at" = now()
 WHERE "module_key" = 'biz_hr' AND "document_key" = 'other';
