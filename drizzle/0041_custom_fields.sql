-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0041 — a super admin can ADD a field, not only adjust the ones shipped   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- /admin/document-fields could configure any field src/lib/documentCategoryFields.ts
-- declares, and nothing else. `applyOverrides` maps over the compiled specs, so
-- it can only ever modify one; the PUT route refuses a fieldKey the category
-- does not declare. This adds the five columns that let a row DEFINE a field
-- instead of adjusting one, describe it, and offer a list of answers.
--
-- ── WHY HERE AND NOT IN A TABLE OF ITS OWN ─────────────────────────────────
-- This table already carries the one constraint a custom field needs: the
-- unique index on (category_id, field_key). That is what makes a custom key
-- colliding with a dictionary key impossible — in a separate table the two
-- namespaces could overlap and the winner would depend on load order.
--
-- It also keeps a property src/lib/records/fieldOverrides.ts is built around:
-- overrides are applied in EXACTLY TWO places, `loadCategoryFieldSpec` and
-- `loadEncryptionPolicy`. A second table would have to be threaded through both
-- of them, and the encryption one is the half nobody would remember.
--
-- The payoff is that `applyPolicyOverrides` already seals any key whose
-- override says is_pii = true, so a custom field marked Encrypted is sealed by
-- code that was written before custom fields existed and needs no change.
--
-- ── THE CHECK CONSTRAINT IS THE POINT ──────────────────────────────────────
-- Every other column here is nullable because NULL means "no view expressed —
-- use the dictionary". A custom field has no dictionary entry behind it, so a
-- NULL label or data type is not "unset", it is a field that cannot be
-- rendered, validated or classified. The constraint makes that state
-- unrepresentable rather than leaving it to whichever route writes the row.
--
-- ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
-- No tenant_id. The taxonomy is global and a super admin is a platform role, so
-- this table still carries NO RLS policy — it appears in neither list in
-- scripts/apply-rls.js and is exempted explicitly in tests/rlsCoverage.test.ts.
-- A custom field added here appears for every tenant, which is the same reach
-- every other column in this table already has.
--
-- No field_key rename, for custom rows either. The key is what already-sealed
-- ciphertext is stored under. A custom field may be DELETED (its row removed —
-- values already written stay in tenants' vaults under that key, unreadable
-- from here because record bodies live encrypted on their own Drives), but it
-- may never be renamed.
--
-- Additive and forward-only: five nullable-or-defaulted columns and one CHECK.
-- Every existing row satisfies the constraint, since is_custom defaults false.

ALTER TABLE "document_category_field_overrides"
  ADD COLUMN IF NOT EXISTS "is_custom"   boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "description" text,
  ADD COLUMN IF NOT EXISTS "display"     varchar(16),
  ADD COLUMN IF NOT EXISTS "options"     jsonb,
  ADD COLUMN IF NOT EXISTS "is_reminder" boolean;
--> statement-breakpoint

-- A custom row IS the field, so it must be renderable. A dictionary row may
-- leave both NULL — that is what "no view expressed" looks like.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'document_category_field_overrides_custom_defined'
  ) THEN
    ALTER TABLE "document_category_field_overrides"
      ADD CONSTRAINT "document_category_field_overrides_custom_defined"
      CHECK (
        NOT "is_custom"
        OR ("field_label" IS NOT NULL AND "data_type" IS NOT NULL)
      );
  END IF;
END $$;
--> statement-breakpoint

-- Serves "which categories have custom fields", which the admin category list
-- asks for all 83 rows at once.
CREATE INDEX IF NOT EXISTS "document_category_field_overrides_custom_idx"
  ON "document_category_field_overrides" ("category_id")
  WHERE "is_custom";
