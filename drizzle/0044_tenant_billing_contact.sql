-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0044 — tenants.billing_email / billing_phone / contact_name             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A tenant had no contact details of its own. The super admin's workspace list
-- could show a name and a UUID and nothing else, because the only email or
-- phone number anywhere in reach belonged to the TENANT_ADMIN *user* row — the
-- account that signs in.
--
-- That account is still the source of truth for who the owner is, and it stays
-- that way: these columns do not duplicate it. They carry the BILLING contact,
-- which is routinely a different party — an accounts inbox, a company landline,
-- a finance manager who never logs in. They sit beside `billing_name`,
-- `billing_gst` and `billing_address`, which were already here and had the same
-- gap: a registered name and a GSTIN with no one to send the invoice to.
--
-- ── WHY NOT REUSE THE ADMIN'S CONTACT ──────────────────────────────────────
-- Because `users.phone_number` carries a platform-wide unique index over live
-- rows (`users_phone_dial_uq`, added by 0039) — one live account per handset.
-- A billing landline shared by three corporate tenants cannot live in that
-- column without colliding, and it must not: it is not a sign-in identity and
-- must never be resolvable to an account.
--
-- ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
-- No backfill. Copying the admin's address into `billing_email` would create a
-- second, silently stale copy of a value that already has an owner; a NULL here
-- means "no separate billing contact", and the UI falls back to showing the
-- owner's own details.
--
-- Additive: three nullable columns. No constraint, no index, nothing rewritten.

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_email" varchar(255);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_phone" varchar(50);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "contact_name" varchar(255);
