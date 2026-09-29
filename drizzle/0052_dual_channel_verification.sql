-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0052 — one code per channel, and a flag that means what it says         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Until now a TENANT_ADMIN's first-login challenge was ONE six-digit code sent
-- down two channels: awaited by email, fire-and-forget by WhatsApp. Redeeming
-- it therefore proved the person held the inbox OR the handset — never both —
-- which is not what a two-channel challenge is for.
--
-- Worse, a STANDARD member's WhatsApp code was stored in
-- `email_verification_otp` and cleared into `email_verified`: a column pair no
-- email had ever touched. `email_verified` consequently meant "mobile verified"
-- for one role and "email verified" for another, and every reader of it had to
-- know the role to know what it was being told.
--
-- This adds the phone half so each channel owns its own flag, its own code and
-- its own expiry. `email_verified` now means the address, and only the address.
-- Which channels a role must clear lives in `requiredChannels()`
-- (src/lib/otpChallenge.ts), not in the schema.
--
-- ── ADDITIVE AND FORWARD-ONLY ──────────────────────────────────────────────
-- Three new columns and two UPDATEs. Nothing is dropped or renamed: the old
-- columns keep their meaning for the email channel, so a build serving traffic
-- against the pre-migration schema is wrong but not broken, and this migration
-- can land before the deploy that uses it.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_verified" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_verification_otp" varchar(255);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_verification_otp_expiry" timestamp with time zone;

-- ── NOBODY WHO IS ALREADY IN GETS LOCKED OUT ───────────────────────────────
-- Every existing account cleared the single challenge that existed at the time,
-- whichever channel carried it. Shipping `DEFAULT false` without this line
-- would re-challenge every tenant admin on their next sign-in — over an email
-- channel that has been silently failing since 2 Sep, i.e. it would lock every
-- one of them out of their own workspace.
--
-- A member's flag was set by a WhatsApp code, so copying it across is not a
-- generous reading: it is literally what was proved.
UPDATE "users" SET "phone_verified" = "email_verified";

-- ── AN IN-FLIGHT MEMBER CHALLENGE SURVIVES THE DEPLOY ──────────────────────
-- A member holding an un-redeemed code has its hash in the EMAIL columns, and
-- after this deploy their code is checked against the PHONE columns. Without
-- this, the message on their handset stops working the moment the build ships
-- and reads to them as the platform rejecting a code it just sent.
--
-- Only members: a tenant admin mid-challenge keeps their still-valid email code
-- and simply gets a phone code from Resend, which is the correct outcome and
-- needs no special case.
UPDATE "users"
   SET "phone_verification_otp" = "email_verification_otp",
       "phone_verification_otp_expiry" = "email_verification_otp_expiry"
 WHERE "role" = 'STANDARD'
   AND "email_verified" = false
   AND "email_verification_otp" IS NOT NULL;
