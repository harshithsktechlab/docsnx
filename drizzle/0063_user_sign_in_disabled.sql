-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0063 — a member's sign-in can be turned off without removing them       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The only way to stop a member signing in used to be removing them, which
-- soft-deletes the row and takes them out of every holder picker, so the admin
-- could no longer file records under them. `sign_in_disabled_at` blocks
-- authentication alone and leaves the member in the workspace. Nullable, so
-- every existing row reads as "sign-in enabled".

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "sign_in_disabled_at" timestamp with time zone;
