-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0042 — clear operator rules set on the two fields no form renders       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- `holder_name` and `custom_fields` are never rendered as an input: the first is
-- answered by the "Belongs to" picker, the second by the free-text label/value
-- rows. /admin/document-fields nonetheless offered Mandatory and Identifier for
-- them, and Mandatory was not merely useless — it was a trap:
--
--   · buildTaxonomyRecord validated the WHOLE spec, so POST /api/modules/:m/:d
--     and POST /api/documents answered 400 `fieldErrors.holder_name` — "Please
--     correct the highlighted fields", with nothing highlighted;
--   · the bulk-scan grid counted it into "N records need attention — check the
--     fields marked below" and marked none.
--
-- Either way the write was refused BEFORE createRecord ran its duplicate check,
-- so a working duplicate check looked like a missing one. On this database it
-- was `identity/aadhaar_card`.`holder_name`, and no Aadhaar card could be saved
-- from any of the three upload paths.
--
-- The code no longer honours the rule (src/lib/records/fieldValidation.ts
-- `FORM_HIDDEN_KEYS`) and the API no longer accepts it, so this is tidying, not
-- a fix: it stops the screen showing a switch that has already stopped meaning
-- anything. Only these two columns, only these two keys — every other setting an
-- operator made on those rows (label, order, description) is left alone.
--
-- Forward-only. No DDL, no row removed: a row left all-NULL by this is exactly
-- what "Reset" writes, and the API prunes it on the operator's next save.

UPDATE "document_category_field_overrides"
   SET "is_required"   = NULL,
       "is_identifier" = NULL
 WHERE "field_key" IN ('holder_name', 'custom_fields')
   AND ("is_required" IS NOT NULL OR "is_identifier" IS NOT NULL);
