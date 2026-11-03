-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0093 — Forgot password by one-time code                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- "Forgot password" used to mail a link. It now sends a six-digit code, on
-- WhatsApp first and by email when WhatsApp cannot carry it; a correct code is
-- then exchanged for the ordinary single-use reset token.
--
-- Its own table, NOT columns on `users` / `identities`. Credentials are copies
-- on every seat, held equal by the 0081/0082 triggers, and each new credential
-- column would mean rewriting those trigger functions. This state is transient
-- and per person, so it lives beside them. It must also never share the
-- `reset_token` column: /api/auth/reset-password redeems any value whose hash
-- matches it, and a six-digit code there could be walked from that route
-- without ever touching the attempt counter below.
--
-- One row per person (`subject_id` = the identity id, or the user id when a row
-- has none). A new request overwrites the old code and zeroes `attempts`.
-- Holds only the keyed hash of a code, never the code. No tenant_id, so no RLS
-- (not in apply-rls.js's tenantScopedTables): it is read before a tenant is
-- known, like `identities`.
--
-- Idempotent and forward-only.
CREATE TABLE IF NOT EXISTS "password_reset_otps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_id" uuid NOT NULL,
  "otp_hash" varchar(255) NOT NULL,
  "channel" varchar(8) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_otps_subject_uq" ON "password_reset_otps" ("subject_id");
