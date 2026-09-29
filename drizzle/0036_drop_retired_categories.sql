-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0036 — reap the 15 retired category rows                                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- `document_categories` carried 98 rows for a live taxonomy of 83. The extra 15
-- were tombstones, every one `<old_module>/miscellaneous`:
--
--   documents, medical, lic_mediclaim, bank_info, trading, investments,
--   loans_debt, vehicles, tax_compliance, wills_estate, warranty, rentals,
--   utility_bills, employment_payroll, corporate_compliance
--
-- 0017 created them — one catch-all per module — and 0023 retired them in
-- favour of the single global `other/uncategorized`, flipping is_active and
-- leaving the rows behind. They have been invisible in the app ever since
-- (every picker, nav and resolver filters is_active) but visible in any direct
-- view of the table, which is what prompted this.
--
-- 0035 removed the same 15 categories' rows from `document_category_fields`.
-- This is the other half.
--
-- ── THE RULE THIS NARROWS ─────────────────────────────────────────────────
-- src/db/schema.ts says of this table: retire a row with is_active = false;
-- never DELETE. That rule is about a category something POINTS AT — deleting
-- one orphans every document resolved from it and breaks the Drive AAD its
-- ciphertext is bound to. It is not about a tombstone nothing references, and
-- the guards below are what establish the difference. The docblock is amended
-- in the same commit to say so; do not read this migration as licence to delete
-- a category in general.
--
-- ── ONE-WAY ────────────────────────────────────────────────────────────────
-- These rows are reconstructible only from the text of 0017. Nothing can create
-- a reference to them either: isSeededCategory 404s the pairs before
-- authentication, resolveCategory filters is_active on both its id and its
-- key-pair branch, and neither seed script has them in DOCUMENT_CATEGORY_SEED.
--
-- ⚠ RESTORING AN OLD BACKUP: a dump taken BEFORE 0023 may hold a document whose
-- category_id is one of these; restoring it after this migration would fail the
-- documents_category_id_fkey RESTRICT. Any dump taken after 0023 cannot — its
-- step 2a repointed every such document to other/uncategorized. If that ever
-- happens, repoint the affected rows the same way rather than re-inserting the
-- category.
--
-- No RLS change. `document_categories` is global reference data — no tenant_id,
-- no policy, absent from both lists in scripts/apply-rls.js.

DO $$
DECLARE n int;
BEGIN
  -- A document filed under a category about to disappear would be left unable
  -- to resolve its own taxonomy. Soft-deleted rows COUNT: they are restorable,
  -- so a tombstone is exactly as load-bearing as a live row here. The
  -- denormalised pair is checked beside the FK because a row can carry one
  -- without the other.
  SELECT count(*) INTO n
    FROM "documents" d
   WHERE d."category_id" IN (SELECT "id" FROM "document_categories" WHERE "is_active" = false)
      OR (d."category_module_key", d."category_document_key") IN (
           SELECT "module_key", "document_key"
             FROM "document_categories" WHERE "is_active" = false
         );
  IF n > 0 THEN
    RAISE EXCEPTION '% document(s) reference a retired category — refusing to delete it', n;
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE n int;
BEGIN
  -- document_category_fields.category_id is ON DELETE **CASCADE**, so without
  -- this the delete below would silently take an encrypt policy with it — the
  -- one outcome here that could ever cost a record its sealing. 0035 emptied
  -- this, but a guard that assumes an earlier migration ran is not a guard.
  SELECT count(*) INTO n
    FROM "document_category_fields" f
    JOIN "document_categories" c ON c."id" = f."category_id"
   WHERE c."is_active" = false;
  IF n > 0 THEN
    RAISE EXCEPTION
      '% encrypt policy row(s) still belong to a retired category — run 0035 first', n;
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE n int;
BEGIN
  -- `permissions` names the taxonomy by STRING with no foreign key, so nothing
  -- else in the database would notice a grant pointing at a category that no
  -- longer exists. Matched on the PAIR: `tax_compliance` and `utility_bills`
  -- survived 0023 as live module keys, and a module-wide grant on either is
  -- perfectly valid — only a grant naming the retired sub-category is not.
  SELECT count(*) INTO n
    FROM "permissions" p
   WHERE (p."module", p."document_key") IN (
           SELECT "module_key", "document_key"
             FROM "document_categories" WHERE "is_active" = false
         );
  IF n > 0 THEN
    RAISE EXCEPTION '% permission row(s) grant access to a retired category', n;
  END IF;
END $$;
--> statement-breakpoint

-- By predicate, never by id: category ids are generated at migration time and
-- differ per environment, so a hard-coded list would delete nothing in one
-- database and the wrong rows in another. The guards above are what make this
-- safe; the predicate only says which rows.
DELETE FROM "document_categories" WHERE "is_active" = false;
--> statement-breakpoint

DO $$
DECLARE total int; active int;
BEGIN
  SELECT count(*) INTO total  FROM "document_categories";
  SELECT count(*) INTO active FROM "document_categories" WHERE "is_active";

  -- The invariant this establishes: the table IS the live taxonomy, with no
  -- tombstones left behind it.
  IF total <> active THEN
    RAISE EXCEPTION
      '% row(s) remain but only % are active — retired rows survived the delete',
      total, active;
  END IF;
END $$;
