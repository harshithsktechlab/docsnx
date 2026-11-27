-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0103 — Corporate health insurance sub-category                          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Employer group mediclaim e-cards carry an employer, a TPA, an employee code
-- and one card per insured person, which the individual health policy form has
-- no room for. Adds `insurance/corporate_health_insurance`, moves the module's
-- `other` after it, and adds the derived individual-client row (see 0098).
-- Field specs are written by scripts/seed_document_category_fields.ts, which
-- `npm run migrate` runs next.
INSERT INTO "document_categories"
  ("module_no","module_key","module_name","document_key","document_name","sort_order","is_system","is_active")
SELECT v.module_no, v.module_key, v.module_name, v.document_key, v.document_name, v.sort_order, true, true
FROM (VALUES
  (3,'insurance','Insurance','corporate_health_insurance','Corporate health insurance (employer group mediclaim)',3007)
) AS v(module_no, module_key, module_name, document_key, document_name, sort_order)
ON CONFLICT ("module_key","document_key") DO NOTHING;
--> statement-breakpoint
UPDATE "document_categories"
   SET "sort_order" = 3008, "updated_at" = now()
 WHERE "module_key" = 'insurance' AND "document_key" = 'other';
--> statement-breakpoint
-- Make room after the source's neighbours inside Client Documents — Individual.
UPDATE "document_categories"
   SET "sort_order" = "sort_order" + 1, "updated_at" = now()
 WHERE "module_key" = 'biz_client_individual' AND "sort_order" >= 117029;
--> statement-breakpoint
INSERT INTO "document_categories"
  ("module_no","module_key","module_name","document_key","document_name","sort_order","is_system","is_active")
SELECT v.module_no, v.module_key, v.module_name, v.document_key, v.document_name, v.sort_order, true, true
FROM (VALUES
  (117,'biz_client_individual','Client Documents — Individual','insurance-corporate_health_insurance','Corporate health insurance (employer group mediclaim)',117029)
) AS v(module_no, module_key, module_name, document_key, document_name, sort_order)
ON CONFLICT ("module_key","document_key") DO NOTHING;
