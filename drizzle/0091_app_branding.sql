-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0091 — Super-admin-managed application logo                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The DocsNX logo used to be a static file. The super admin can now upload a
-- replacement under Admin → Branding; it is served to everyone, logged in or
-- not, from /api/brand/logo.
--
-- Its own table, not columns on `system_configs`: that row is read whole by the
-- settings routes, and a base64 image must never ride along with it. This is the
-- application's logo, NOT the invoice entity's (`system_configs.platform_logo`).
--
-- One platform-wide row, no tenant_id, so no RLS (it is not in apply-rls.js's
-- tenantScopedTables). No row means "use the built-in mark", so existing
-- installs behave exactly as before the moment this runs.
--
-- Idempotent and forward-only.
CREATE TABLE IF NOT EXISTS "app_branding" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "logo_content_type" varchar(50) NOT NULL,
  "logo_data" text NOT NULL,
  "logo_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
