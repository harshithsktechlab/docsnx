-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0025 — the category FORM spec becomes data, and custom fields get sealed ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Two changes, one table, both additive. Forward-only: nothing is dropped and
-- no existing value is rewritten except by appending to a list.
--
-- 1. `fields` — every field a category can carry, with its label, data type,
--    required flag and validation rule. Until now that lived only in
--    src/lib/documentCategoryFields.ts, which is a thousand lines of dictionary
--    the browser must never download. The new sub-category page renders its add
--    form from this column, so the form for `identity/pan_card` asks for PAN
--    Card's fields and validates a PAN as a PAN.
--
--    Left NULL here rather than backfilled in SQL: the payload is ~83 JSON
--    documents totalling a few hundred KB, and generating them from the TS
--    source is what keeps the two in step. Run, immediately after this:
--
--        npx tsx scripts/seed_document_category_fields.ts
--
--    Readers fall back to the compiled-in spec while the column is NULL, so the
--    gap between migrating and seeding is degraded, not broken.
--
-- 2. `custom_fields` — the new form lets a user add their own label/value rows.
--    `splitRecordFields` seals ONLY the keys named in `encrypted_fields`, so a
--    key absent from that list is written to Postgres in the clear. Free text a
--    user types is exactly where an unanticipated account number ends up, so the
--    key is appended to EVERY category's encrypt list before the form can write
--    one. Sealing a field the record does not carry costs nothing — the split
--    intersects the policy with the keys actually present.

ALTER TABLE "document_category_fields" ADD COLUMN IF NOT EXISTS "fields" jsonb;
--> statement-breakpoint

-- Idempotent: a re-run must not produce `…,custom_fields,custom_fields`.
UPDATE "document_category_fields"
   SET "encrypted_fields" = CASE
         WHEN "encrypted_fields" IS NULL OR btrim("encrypted_fields") = ''
           THEN 'custom_fields'
         ELSE "encrypted_fields" || ',custom_fields'
       END,
       "updated_at" = now()
 WHERE ('custom_fields' <> ALL (
          SELECT btrim(k) FROM unnest(string_to_array(coalesce("encrypted_fields", ''), ',')) AS k
       ));
--> statement-breakpoint

DO $$
DECLARE n int;
BEGIN
  -- Every policy row must now name custom_fields. A row that does not would
  -- write user-entered free text to the open tier in the clear, which is the
  -- one thing this half of the migration exists to prevent.
  SELECT count(*) INTO n
    FROM "document_category_fields"
   WHERE ('custom_fields' <> ALL (
            SELECT btrim(k) FROM unnest(string_to_array(coalesce("encrypted_fields", ''), ',')) AS k
         ));
  IF n > 0 THEN
    RAISE EXCEPTION '% category policies do not seal custom_fields', n;
  END IF;
END $$;

-- POST-CHECKS (run manually after seeding; not part of the migration):
--   SELECT count(*) FILTER (WHERE fields IS NULL) AS unseeded,
--          count(*) FILTER (WHERE jsonb_array_length(fields) = 0) AS empty,
--          count(*) AS total
--     FROM document_category_fields;
--   -- expect unseeded = 0, empty = 0, total = 83
