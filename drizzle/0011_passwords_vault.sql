-- ═══════════════════════════════════════════════════════════════════════════
--  Passwords join the vault.
--
--  A credential has no file, so unlike the twelve file-bearing modules it needs
--  only the JSON-store pointers — there is no file_drive_id or content_hash.
--
--  `password_encrypted` becomes NULLABLE. The secret now lives in the tenant's
--  Drive store, sealed with the tenant key and additionally encryptField-ed
--  inside it; keeping a copy in Postgres would contradict "we store metadata
--  only". The column is kept rather than dropped so existing rows stay readable
--  and a rollback is possible — a later migration drops it once nothing reads
--  it.
--
--  Purely additive plus one NOT NULL relaxation: no rewrite, no data touched.
--  Hand-written like 0006-0010, since the meta snapshots stop at 0005.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "passwords"
  ADD COLUMN IF NOT EXISTS "category_code" varchar(120),
  ADD COLUMN IF NOT EXISTS "json_drive_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "json_url" text,
  ADD COLUMN IF NOT EXISTS "key_version" integer,
  ADD COLUMN IF NOT EXISTS "email" varchar(255),
  ADD COLUMN IF NOT EXISTS "phone" varchar(40),
  ADD COLUMN IF NOT EXISTS "status" varchar(24) DEFAULT 'active' NOT NULL;--> statement-breakpoint

-- The secret moves to Drive; Postgres keeps the searchable identifiers only.
ALTER TABLE "passwords" ALTER COLUMN "password_encrypted" DROP NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "passwords_tenant_status_idx"
  ON "passwords" USING btree ("tenant_id","status") WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "passwords_tenant_category_code_idx"
  ON "passwords" USING btree ("tenant_id","category_code");

-- POST-CHECKS (run manually; not part of the migration):
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name='passwords'
--      AND column_name IN ('category_code','json_drive_id','json_url',
--                          'key_version','email','phone','status');        -- 7
--   SELECT is_nullable FROM information_schema.columns
--    WHERE table_name='passwords' AND column_name='password_encrypted';    -- YES
