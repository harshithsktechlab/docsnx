-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0089 — A combo account's personal side gets its own name                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A combo (`account_type = 'both'`) tenant had ONE name, `tenants.name`, which
-- was both the account's umbrella name and what its personal side was called.
-- `tenants.name` stays the account / business name; this holds the personal
-- side's own name.
--
-- NULL means "no separate personal name" and readers fall back to `name`, so
-- every existing tenant keeps showing exactly what it showed before. Nullable,
-- no default, no backfill: forward-only and safe to run on a live table.

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "personal_workspace_name" varchar(255);
