-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0094 — Super-admin-managed Bulk Scan limits                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Files per scan (was a hardcoded 15), pages per scan (40) and total bytes per
-- scan (60 MB) are now set under Admin → Field Config → File Size, beside the
-- per-file upload cap (`max_upload_bytes`).
--
-- Nullable: NULL means "no view expressed", and the built-in default answers,
-- so every install behaves exactly as before until an admin sets a value.
--
-- Idempotent and forward-only.
ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "max_scan_files" integer;--> statement-breakpoint
ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "max_scan_pages" integer;--> statement-breakpoint
ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "max_scan_bytes" integer;
