-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0080 — Profile photos                                                   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Until now a person was only ever their initials. Members can now upload a
-- photo of their own (PUT /api/account/avatar).
--
-- A table of its own rather than a column on `users`: `users` is read whole by
-- getUserFromRequest, /api/auth/me and the admin roster, and none of them
-- should be hauling a base64 image around. The image is resized in the browser
-- to ~256px before upload and capped server-side, so a row stays small.
--
-- `data` is the base64 of the image bytes; `content_type` is the type the
-- server sniffed from them, never the one the client claimed.
--
-- Idempotent. RLS is applied by scripts/apply-rls.js (user_avatars is in its
-- tenantScopedTables list), which `npm run migrate` runs after this file.
CREATE TABLE IF NOT EXISTS "user_avatars" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "content_type" varchar(50) NOT NULL,
  "data" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "user_avatars_tenant_idx" ON "user_avatars" ("tenant_id");
