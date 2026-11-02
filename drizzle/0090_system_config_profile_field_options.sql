-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0090 — Super-admin-managed dropdown options for the company profile     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The company profile's "Entity Type" was free text. Its choices are now a
-- platform setting edited under Admin → Field Config → Company Profile, kept on
-- the single `system_configs` row beside `max_upload_bytes`.
--
-- Shape: { "entityType": [ { "value": "...", "label": "..." }, ... ] }, keyed so
-- further company-profile dropdowns can join without another column.
--
-- NULL means "no view expressed" and readers fall back to the built-in list in
-- src/lib/profileFieldOptions.ts, so existing installs behave sensibly the
-- moment this runs. Nullable, no default, no backfill: forward-only and safe on
-- a live table.

ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "profile_field_options" jsonb;
