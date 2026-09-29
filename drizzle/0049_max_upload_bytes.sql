-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0049 — configurable per-file upload size limit                          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The per-file upload cap is currently hardcoded as 25 MB (MAX_UPLOAD_BYTES in
-- src/lib/records/uploadTypes.ts). This migration adds a platform-wide config
-- column to allow a super admin to adjust it from the UI without code changes.
--
-- NULL means "use the platform default" (25 MB). The app enforces a ceiling of
-- 100 MB (nginx's client_max_body_size on prod), which is validated both client
-- and server.

ALTER TABLE "system_configs"
  ADD COLUMN IF NOT EXISTS "max_upload_bytes" integer;
