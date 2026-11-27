-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0102 — fallback AI key, settable from Admin → AI Settings               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The last-resort key was GEMINI_API_KEY in the server's env file only. A row
-- marked is_fallback is tried after the whole pool and replaces that env key.
-- Every existing key defaults to false, so nothing changes until one is set.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS is_fallback boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- At most one fallback key.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_single_fallback_uq
  ON api_keys (is_fallback) WHERE is_fallback;
