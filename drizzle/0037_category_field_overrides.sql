-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0037 — per-field overrides a super admin sets from /admin/document-fields ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- One row per (category, field) an operator has configured. Everything not
-- configured keeps following the compiled dictionary.
--
-- ── WHY A SEPARATE TABLE ───────────────────────────────────────────────────
-- `document_category_fields` is a COPY of src/lib/documentCategoryFields.ts,
-- and scripts/seed_document_category_fields.ts rewrites all five of its columns
-- for all 83 rows on every run — deliberately, so a stored policy cannot drift
-- from the code that reasons about it. An admin edit written into that table
-- would be erased by the next deploy, silently and unrecoverably.
--
-- Overrides live apart so BOTH properties hold at once: an admin's choice
-- survives a re-seed, and a later dictionary fix still reaches every field the
-- admin has not touched.
--
-- ── EVERY COLUMN NULLABLE, AND NULL IS NOT false ───────────────────────────
-- NULL = "no view expressed, use the dictionary". false = "the admin turned
-- this off". Collapsing the two would make Reset impossible and would freeze a
-- field against future dictionary changes on a value that only meant "unset".
--
-- ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
-- No `field_key` rename and no delete. The key is what already-sealed
-- ciphertext is stored under; renaming or removing one strands that data.
-- Retiring a field is `is_hidden`, which stops it being rendered or accepted
-- while leaving existing values retrievable through the reveal path.
--
-- No tenant_id: the taxonomy is global and a super admin is a platform role, so
-- this table carries NO RLS policy — it appears in neither list in
-- scripts/apply-rls.js and is exempted explicitly in tests/rlsCoverage.test.ts.
--
-- Additive and forward-only: creates one table, touches nothing existing.

CREATE TABLE IF NOT EXISTS "document_category_field_overrides" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "category_id"   uuid NOT NULL
                    REFERENCES "document_categories"("id") ON DELETE CASCADE,
  "field_key"     varchar(100) NOT NULL,

  "field_label"   varchar(200),
  "data_type"     varchar(16),
  "is_pii"        boolean,
  "is_required"   boolean,
  "is_printed"    boolean,
  "is_identifier" boolean,
  "is_hidden"     boolean,
  "sort_order"    integer,
  "validation"    jsonb,

  "updated_by"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"    timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"    timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- One override row per field per category: the row IS that field's config, so a
-- second row for the same pair would make "the" override ambiguous. Also the
-- conflict target the admin API upserts on.
CREATE UNIQUE INDEX IF NOT EXISTS "document_category_field_overrides_field_idx"
  ON "document_category_field_overrides" ("category_id", "field_key");
