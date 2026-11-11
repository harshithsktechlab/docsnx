-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0095 — Sales & Marketing: collateral sub-categories                     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- `biz_sales` listed contract-style sub-categories (Sales Agreements, Marketing
-- Collateral Approvals, Customer Contracts / SLAs, Warranty Documents) that do
-- not match what a company files under Sales & Marketing: its own profile,
-- decks and collateral. Seven collateral sub-categories are added and the four
-- old ones are RETIRED.
--
-- RETIRED, never deleted and never renamed: a key is a Drive folder name and
-- half the AAD binding of every ciphertext filed under it, and
-- documents.category_id is ON DELETE RESTRICT. Anything already filed under an
-- old key stays intact and readable; the row just stops being offered in the
-- pickers. The TS constant in src/lib/documentCategories.ts no longer lists
-- them, so scripts/seed_document_categories.ts cannot re-activate them.
--
-- `other` (0084) is kept; it moves to the end of the list.
-- The field spec / encryption policy for the new rows is written by
-- scripts/seed_document_category_fields.ts, which `npm run migrate` runs next.
INSERT INTO "document_categories"
  ("module_no","module_key","module_name","document_key","document_name","sort_order","is_system","is_active")
SELECT v.module_no, v.module_key, v.module_name, v.document_key, v.document_name, v.sort_order, true, true
FROM (VALUES
  (113,'biz_sales','Sales & Marketing','company_profile','Company Profile',113001),
  (113,'biz_sales','Sales & Marketing','pitch_deck','Pitch Deck',113002),
  (113,'biz_sales','Sales & Marketing','marketing_deck','Marketing Deck',113003),
  (113,'biz_sales','Sales & Marketing','marketing_materials','Marketing Materials',113004),
  (113,'biz_sales','Sales & Marketing','brochures_catalogs','Brochures & Catalogs',113005),
  (113,'biz_sales','Sales & Marketing','case_studies_testimonials','Case Studies & Testimonials',113006),
  (113,'biz_sales','Sales & Marketing','price_lists_quotations','Price Lists & Quotations',113007)
) AS v(module_no, module_key, module_name, document_key, document_name, sort_order)
ON CONFLICT ("module_key","document_key") DO NOTHING;
--> statement-breakpoint
UPDATE "document_categories"
   SET "sort_order" = 113008, "updated_at" = now()
 WHERE "module_key" = 'biz_sales' AND "document_key" = 'other';
--> statement-breakpoint
UPDATE "document_categories"
   SET "is_active" = false, "updated_at" = now()
 WHERE "module_key" = 'biz_sales'
   AND "document_key" IN ('sales_agreements','marketing_collateral_approvals','customer_contracts_slas','warranty_documents');
