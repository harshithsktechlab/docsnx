-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0101 — 7-day free trial of the selected plan                            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A trial is stored in the existing plan/expiry columns; these only mark it as
-- unpaid. `trial_eligible` defaults to false on purpose: every tenant that
-- exists today stays as it is, and only accounts opened from now on qualify.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS trial_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS trial_plan_id uuid,
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_converted_at timestamptz;
--> statement-breakpoint
-- One trial per person: by email OR mobile number. The table already holds the
-- emails that used the earlier trial scheme, and those keep counting.
ALTER TABLE trial_used_emails ADD COLUMN IF NOT EXISTS phone_dial varchar(20);
--> statement-breakpoint
ALTER TABLE trial_used_emails ALTER COLUMN email DROP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS trial_used_emails_phone_dial_unique
  ON trial_used_emails (phone_dial);
