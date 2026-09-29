-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0048 — how many days before a deadline the alert should reach the user  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Every expiry and renewal in the app fired on ONE global constant:
-- ALERT_THRESHOLD_DAYS = 15 (src/lib/records/followUps.ts). A passport that
-- wants six months' notice and an electricity bill that wants three surfaced on
-- the same day, and nobody — super admin or household — could change it.
--
-- `is_reminder` already answers WHETHER a date alerts. This is its sibling and
-- answers HOW EARLY, with the same three-state rule the rest of this table
-- follows: NULL means "the admin has expressed no view", and the compiled
-- dictionary answers (ALERT_DAYS_BY_KEY in src/lib/records/reminderPolicy.ts,
-- falling back to 15). It is NOT `DEFAULT 15` for exactly that reason — a
-- default would freeze every field against future dictionary changes on the
-- strength of a value that only ever meant "unset", and would make Reset
-- impossible.
--
-- ⚠ 0 IS A REAL ANSWER: "tell me on the day it expires". Never write 0 to mean
-- unset; write NULL. Readers use `??`, not `||`, throughout.
--
-- The upper bound is a year. Beyond that the reminder is permanently on the
-- follow-up page and has stopped being a reminder. The same 0…365 range is
-- enforced by `normaliseAlertDays` and by the admin API's zod schema, so the
-- form, the route and the table all refuse the same values.
--
-- No tenant column, and no RLS policy: this table is global reference data a
-- super admin owns — see scripts/apply-rls.js, where it appears in neither list,
-- and tests/rlsCoverage.test.ts, which exempts it explicitly.
--
-- Forward-only and additive. Existing rows get NULL, which is precisely "no
-- change in behaviour" — every field keeps answering from the dictionary.
--
-- The per-RECORD half of this feature needs no DDL: `alert_days_before` is a
-- baseline taxonomy field, so it is stored inside the tenant's own vault record
-- (open tier) like every other field, not in a column here.

ALTER TABLE "document_category_field_overrides"
  ADD COLUMN IF NOT EXISTS "alert_days_before" integer;

ALTER TABLE "document_category_field_overrides"
  DROP CONSTRAINT IF EXISTS "document_category_field_overrides_alert_days_range";

ALTER TABLE "document_category_field_overrides"
  ADD CONSTRAINT "document_category_field_overrides_alert_days_range"
  CHECK (
    "alert_days_before" IS NULL
    OR ("alert_days_before" >= 0 AND "alert_days_before" <= 365)
  );
