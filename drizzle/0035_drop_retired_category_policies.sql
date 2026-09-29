-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0035 — drop the policy rows of categories 0023 retired                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- `document_category_fields` held 98 rows against a taxonomy of 83 live
-- categories. The extra 15 were all the same thing: `<module>/miscellaneous`,
-- the generic bucket each module used to carry under the module vocabulary
-- (documents, medical, bank_info, trading, investments, loans_debt, vehicles,
-- wills_estate, warranty, rentals, employment_payroll, corporate_compliance,
-- lic_mediclaim, tax_compliance, utility_bills) that
-- 0023_master_taxonomy_realignment replaced. All fifteen were superseded by the
-- single catch-all `other/uncategorized`, which carries the UNION of every
-- category's fields precisely so an unclassified record still gets sealed.
--
-- 0023 flipped those categories to is_active = false and left their policy rows
-- alone. scripts/seed_document_category_fields.ts walks the 83 seeded
-- categories, so its INSERT … ON CONFLICT never addressed them either: `fields`
-- has been NULL on exactly these 15 since 0025, and 0033/0034's three CSV lists
-- landed on them empty for the same reason. Their `encrypted_fields` is
-- non-empty only because 0008/0015/0018 wrote it while they were still live.
--
-- ── ONE-WAY ────────────────────────────────────────────────────────────────
-- Those encrypt lists exist nowhere else but in the text of 0008/0015/0018.
-- That is acceptable because no record can be WRITTEN under a retired category
-- (withCategory 404s on any pair outside the seed before authentication;
-- resolveCategory filters isActive on both its id and its key-pair branch), and
-- because READING an existing sealed record never consults the policy — the
-- split runs at write time and each record stores its own sealed map.
--
-- ── THE CATEGORIES THEMSELVES STAY ─────────────────────────────────────────
-- Only the POLICY rows go. `documents.category_id` is ON DELETE RESTRICT and
-- the rule for that table is retire-never-delete, so the 15 rows in
-- `document_categories` keep their is_active = false and are left in place.
--
-- ── WHY THIS IS SAFE TO DO AT ALL ──────────────────────────────────────────
-- Deleting a policy row is not inert: loadEncryptionPolicy falls back to the
-- COMPILED policy when it finds no row, and the compiled policy knows only the
-- seeded categories — so for a retired one it answers "seal nothing". The
-- companion change to src/lib/vault/fieldSplitter.ts puts the sealed baseline
-- under that branch as a floor, so an absent row can never mean an unsealed
-- record. Ship the two together; this migration assumes that floor exists.
--
-- No RLS change. `document_category_fields` is global reference data — its
-- tenant_id was dropped in 0008 and it carries no policy, so it appears in
-- neither list in scripts/apply-rls.js. No tenant's records are touched.

DO $$
DECLARE n int;
BEGIN
  -- A record filed under a retired category would lose the list naming which of
  -- its fields are sealed. Nothing can create one today, and none exists — but
  -- this migration must refuse rather than discover otherwise afterwards.
  -- Soft-deleted rows count: they are restorable, and the denormalised pair is
  -- checked alongside the FK because a row can carry one without the other.
  SELECT count(*) INTO n
    FROM "documents" d
   WHERE d."category_id" IN (
           SELECT c."id" FROM "document_categories" c WHERE c."is_active" = false
         )
      OR (d."category_module_key", d."category_document_key") IN (
           SELECT c."module_key", c."document_key"
             FROM "document_categories" c WHERE c."is_active" = false
         );
  IF n > 0 THEN
    RAISE EXCEPTION
      '% document(s) are filed under a retired category — refusing to drop its encrypt policy', n;
  END IF;
END $$;
--> statement-breakpoint

-- By predicate, never by id: category ids are generated at migration time and
-- differ per environment, so a hard-coded list would delete nothing in one
-- database and the wrong rows in another.
DELETE FROM "document_category_fields" f
 USING "document_categories" c
 WHERE c."id" = f."category_id"
   AND c."is_active" = false;
--> statement-breakpoint

DO $$
DECLARE policies int; active int;
BEGIN
  SELECT count(*) INTO policies FROM "document_category_fields";
  SELECT count(*) INTO active   FROM "document_categories" WHERE "is_active";

  -- The invariant this migration establishes: exactly one policy row per ACTIVE
  -- category, and none for a retired one. Asserted rather than assumed because
  -- the failure it guards against — a LIVE category left with no row — is the
  -- one outcome that would genuinely encrypt nothing.
  IF policies <> active THEN
    RAISE EXCEPTION
      'expected one policy row per active category (% active) but % remain', active, policies;
  END IF;
END $$;
