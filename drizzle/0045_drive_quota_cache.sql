-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0045 — tenants.drive_usage_bytes / drive_limit_bytes /                  ║
-- ║         drive_quota_checked_at                                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A Drive-connected tenant had no measured storage consumption anywhere in the
-- system. `getGoogleDriveQuota()` read the real figures from Google on every
-- /api/auth/me and then threw them away — the caller was a fire-and-forget
-- `.then()` whose body only logged — so the sidebar meter fell back to the
-- PLAN's byte count against the PLAN's limit, and the super admin's workspace
-- list showed the literal word "unlimited" where a number belonged.
--
-- These three columns are that measurement, kept where it can be read without
-- calling Google. That matters most for the super admin: listing N workspaces
-- cannot mean N round-trips to the Drive API, and a per-process memory cache
-- would be empty after every deploy and disagree between workers.
--
-- ── WHY NULLABLE, AND WHY NULL IS NOT ZERO ─────────────────────────────────
-- NULL means "never read" — a different state from "read, and empty". Nothing
-- may bill a tenant for NULL, and no write may be refused on it: a missing
-- METRIC must never be mistaken for a full disk. checkStorageLimit() therefore
-- keeps its unlimited fail-open for exactly this case.
--
-- ── LIFECYCLE ──────────────────────────────────────────────────────────────
-- Written whenever the quota is read (a 10-minute TTL bounds how often that
-- is), and cleared wherever the grant dies — handleDriveAuthFailure() and the
-- integrations DELETE — so a stale number can never outlive the connection it
-- described.
--
-- bigint, not integer: a 2 TB Google One plan is 2.2e12 bytes, three orders of
-- magnitude past int4.
--
-- Additive: three nullable columns. No backfill, no constraint, no index,
-- nothing rewritten.

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "drive_usage_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "drive_limit_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "drive_quota_checked_at" timestamp with time zone;
