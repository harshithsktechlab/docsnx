-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0071 — member activation: invited, then the member sets their password  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A member used to be handed a temporary password by the tenant. Now they are
-- invited (WhatsApp / email link to /activate), prove they own the registered
-- number or address with a code, and choose their own password.
--
--   activated_at  the member has chosen their own password. NULL = invited and
--                 not finished; login refuses them and points at /activate.
--   invited_at    when the last invite went out — shown on the Members screen
--                 and the resend cooldown.
--
-- Every EXISTING user is backfilled as activated: they already sign in with the
-- password they have, and nothing about this change may lock them out.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "invited_at" timestamp with time zone;--> statement-breakpoint
UPDATE "users" SET "activated_at" = coalesce("created_at", now()) WHERE "activated_at" IS NULL;
