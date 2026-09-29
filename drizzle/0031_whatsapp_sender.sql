-- ═══════════════════════════════════════════════════════════════════════════
--  0031 — the platform's WhatsApp sender.
--
--  Evolution API runs alongside this app and holds many instances (each one a
--  linked handset). Nothing in docsnx knew which of them to send from, or how
--  to reach the engine at all. These four columns are that configuration, and
--  they sit beside `smtp_*` on purpose: a WhatsApp gateway is the same kind of
--  thing as an SMTP gateway — one platform-wide sender, owned by a SUPER_ADMIN,
--  changed from /admin/whatsapp without a redeploy.
--
--  `whatsapp_api_key` HOLDS CIPHERTEXT, never a raw key. src/lib/encryption.ts
--  encrypts it on the way in and src/lib/whatsapp.ts decrypts it per send, the
--  same contract `smtp_password` has. A plaintext value in this column is a
--  bug, not a supported state.
--
--  `whatsapp_enabled` defaults to FALSE, so this migration turns nothing on.
--  Until a super admin fills in the other three and flips it, every WhatsApp
--  send path short-circuits and the email that has always gone out still does.
--
--  PURELY ADDITIVE — four columns on an existing table. Nothing is dropped,
--  renamed or backfilled.
--
--  No RLS change: `system_configs` is a single platform-wide row with no
--  tenant_id, so it is not one of the tables in scripts/apply-rls.js.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "whatsapp_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "whatsapp_api_url" varchar(255);
--> statement-breakpoint
ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "whatsapp_api_key" text;
--> statement-breakpoint
ALTER TABLE "system_configs" ADD COLUMN IF NOT EXISTS "whatsapp_instance" varchar(255);
