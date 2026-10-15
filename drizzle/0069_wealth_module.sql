-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0069 — Wealth & Valuables (personal 16): bank lockers + locker items    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A household had one place for a locker — bank_investments/
-- bank_locker_agreement — and one free-text box for everything in it. This
-- module gives the locker its own record and every item in it a record of its
-- own (owner, invoice, photos, weight, gift details), linked to its locker by
-- the `locker_ref` field.
--
-- Numbered 16: 1-14 are the master table and 15 is the catch-all. The sidebar
-- follows the TS array order in src/lib/documentCategories.ts, where `wealth`
-- sits before `other`.
--
-- Additive only, ON CONFLICT DO NOTHING like 0065. The field specs are NOT
-- inserted here: `npm run migrate` runs scripts/seed_document_category_fields.ts
-- straight after, which writes them from src/lib/documentCategoryFields.ts.
INSERT INTO "document_categories"
  ("module_no","module_key","module_name","document_key","document_name","sort_order","is_system","is_active")
SELECT v.module_no, v.module_key, v.module_name, v.document_key, v.document_name, v.sort_order, true, true
FROM (VALUES
  (16,'wealth','Wealth & Valuables','bank_lockers','Bank lockers',16001),
  (16,'wealth','Wealth & Valuables','locker_items','Locker inventory — jewellery & valuables',16002)
) AS v(module_no, module_key, module_name, document_key, document_name, sort_order)
ON CONFLICT ("module_key","document_key") DO NOTHING;--> statement-breakpoint

-- ── EXISTING MEMBERS ───────────────────────────────────────────────────────
-- Same reasoning as 0065: an existing standard member has no row for a new
-- module and `hasPermission` denies it. Each inherits the module-level grant
-- they hold on `bank_investments`, where the locker agreement already lives.
INSERT INTO permissions (user_id, module, document_key,
                         can_view, can_add, can_edit, can_delete, can_share)
SELECT p.user_id, 'wealth', NULL,
       p.can_view, p.can_add, p.can_edit, p.can_delete, p.can_share
FROM permissions p
WHERE p.module = 'bank_investments' AND p.document_key IS NULL
ON CONFLICT (user_id, module, (coalesce(document_key, ''))) DO NOTHING;--> statement-breakpoint

-- ── PHOTO BYTES ────────────────────────────────────────────────────────────
-- A locker item carries photos beside its invoice. They are counted here, not
-- in file_size, because replacing the invoice overwrites file_size and would
-- silently drop the photos out of the storage quota.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "attachment_size" bigint DEFAULT 0 NOT NULL;
