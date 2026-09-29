-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0033 — a category's mandatory and complete field lists, as flat CSV      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Two columns, one table, both additive. Forward-only: nothing is dropped and
-- no existing value is rewritten.
--
-- `fields` (added in 0025) already carries `isRequired` on every entry, so
-- neither list is new information — they are the same answer in a shape SQL can
-- read. Reducing 83 JSON documents to find out which keys a sub-category
-- demands is the wrong amount of work for a report, an export mapping or an ops
-- query, and it is not reachable from SQL at all without unnesting the JSONB.
--
--   mandatory_fields → the keys a record cannot be saved without, in form order
--                      identity/pan_card → 'document_title,pan_number'
--   all_fields       → every key the category declares, in form order
--                      identity/pan_card → 'document_title,pan_number,
--                                           father_name,date_of_birth,
--                                           holder_name,issue_date,notes,
--                                           custom_fields'
--
-- Both are PROJECTIONS, not policy. Nothing validates against them: the add
-- form and both write routes read `isRequired` off the `fields` spec
-- (src/lib/records/fieldValidation.ts). A row hand-edited to disagree with
-- `fields` changes nothing except what a SQL reader is told — which is why the
-- seed script overwrites both on every run.
--
-- ── SEEDED FROM TYPESCRIPT, NOT FROM SQL ──────────────────────────────────
-- Same call as 0025 made for `fields`, for the same reason: the lists are
-- derived from src/lib/documentCategoryFields.ts, and generating them from the
-- TS source is what keeps the two in step. A hand-written 83-row VALUES block
-- here would be a second statement of the taxonomy that can drift from the
-- first. The columns therefore land EMPTY. Run, immediately after this:
--
--     npx tsx scripts/seed_document_category_fields.ts
--
-- '' means NOT SEEDED, not "this category has no fields". Nothing reads these
-- columns for behaviour, so the gap between migrating and seeding is invisible
-- rather than merely degraded — unlike 0025's, which emptied every add form.
--
-- No RLS change. `document_category_fields` is global reference data: its
-- tenant_id was dropped in 0008 and it carries no policy, so it appears in
-- neither list in scripts/apply-rls.js. Field KEY names are not tenant data.

ALTER TABLE "document_category_fields"
  ADD COLUMN IF NOT EXISTS "mandatory_fields" text DEFAULT '' NOT NULL;
--> statement-breakpoint

ALTER TABLE "document_category_fields"
  ADD COLUMN IF NOT EXISTS "all_fields" text DEFAULT '' NOT NULL;
