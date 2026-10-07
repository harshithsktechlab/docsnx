-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0064 — selectable email provider (smtp | graph | gmail)                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Additive only. Existing rows default to 'smtp', so mail keeps flowing exactly
-- as before. Secret columns hold AES-GCM ciphertext (src/lib/encryption.ts).

ALTER TABLE "system_configs"
  ADD COLUMN IF NOT EXISTS "email_provider" varchar(16) NOT NULL DEFAULT 'smtp',
  ADD COLUMN IF NOT EXISTS "graph_tenant_id" varchar(255),
  ADD COLUMN IF NOT EXISTS "graph_client_id" varchar(255),
  ADD COLUMN IF NOT EXISTS "graph_client_secret" text,
  ADD COLUMN IF NOT EXISTS "graph_sender_mailbox" varchar(255),
  ADD COLUMN IF NOT EXISTS "gmail_client_email" varchar(255),
  ADD COLUMN IF NOT EXISTS "gmail_private_key" text,
  ADD COLUMN IF NOT EXISTS "gmail_sender_mailbox" varchar(255);
