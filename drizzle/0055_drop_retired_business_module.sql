-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0055 — delete the retired personal `business` module                    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- 0050 retired the 16-category `business` module that sat inside the PERSONAL
-- taxonomy, the conservative way: `is_active = false`, never DELETE. This
-- finishes the job and removes the rows.
--
-- ── WHY A DELETE IS ALLOWED HERE, WHEN THE RULE SAYS NEVER ─────────────────
-- src/lib/documentCategories.ts states the rule plainly: never delete a
-- category row, retire it, because `documents.category_id` is ON DELETE
-- RESTRICT and a deleted category strands its documents. The rule protects
-- DATA, and there is none: 0050 established that nothing was ever filed under
-- this module, and the guard below re-establishes it at the moment of the
-- delete rather than trusting a note written five migrations ago.
--
-- What retiring did not do is remove the module from the operator's view.
-- `GET /api/admin/document-categories` lists rows without an `is_active`
-- filter — deliberately, so a retired row can be restored — so the Categories
-- screen still drew the whole module struck through, with a Restore button on
-- every row. A module the product has replaced should not be one click from
-- coming back, and the fourteen `biz_*` modules are its replacement.
--
-- ── WHAT GOES WITH THEM ────────────────────────────────────────────────────
--   document_category_fields          ON DELETE CASCADE  (the seeded spec)
--   document_category_field_overrides ON DELETE CASCADE  (operator edits)
--   permissions                       no FK — deleted explicitly below
--
-- The `permissions` rows are grants made by pre-0050 signups against a module
-- that no longer exists. They are invisible (the matrix renders from
-- PERMISSION_MODULE_KEYS, which dropped `business`) and unreachable, which is
-- exactly why nothing else would ever clear them.

-- ── 1. Refuse if anything at all still points at the module ────────────────
-- The FK would refuse the DELETE on its own; this exists so the failure names
-- the problem instead of a constraint. Soft-deleted documents count: they are
-- rows, and they are restorable.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM documents d
    JOIN document_categories c ON c.id = d.category_id
   WHERE c.module_key = 'business';
  IF n > 0 THEN
    RAISE EXCEPTION '% documents are filed under the business module — refusing to delete it', n;
  END IF;

  SELECT count(*) INTO n FROM documents WHERE category_module_key = 'business';
  IF n > 0 THEN
    RAISE EXCEPTION '% documents carry the denormalised business category key', n;
  END IF;

  SELECT count(*) INTO n FROM vault_json_files WHERE category_module_key = 'business';
  IF n > 0 THEN
    RAISE EXCEPTION '% vault stores are keyed to the business module', n;
  END IF;

  SELECT count(*) INTO n FROM passwords WHERE category_module_key = 'business';
  IF n > 0 THEN
    RAISE EXCEPTION '% passwords are keyed to the business module', n;
  END IF;
END $$;--> statement-breakpoint

-- ── 2. The rows themselves ─────────────────────────────────────────────────
-- Idempotent: a second run deletes nothing and raises nothing.
DELETE FROM "document_categories" WHERE "module_key" = 'business';--> statement-breakpoint

-- ── 3. The grants nothing else can reach ───────────────────────────────────
DELETE FROM "permissions" WHERE "module" = 'business';--> statement-breakpoint

-- ── 4. Prove it ────────────────────────────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM document_categories WHERE module_key = 'business';
  IF n > 0 THEN RAISE EXCEPTION '% business categories survived the delete', n; END IF;

  -- Every surviving category must still hold a field spec. A cascade that took
  -- a row it should not have would show up here first.
  SELECT count(*) INTO n
    FROM document_categories c
    LEFT JOIN document_category_fields f ON f.category_id = c.id
   WHERE f.id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '% categories lost their field spec', n; END IF;
END $$;

-- POST-CHECK:
--   SELECT count(*) FILTER (WHERE is_active) AS active, count(*) AS total
--     FROM document_categories;
--   -- expect 152 / 152
