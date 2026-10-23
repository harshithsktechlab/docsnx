-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0081 — identities: the PERSON, separated from their tenant membership   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Until now one `users` row was one person AND one seat in one tenant, so a
-- person could not hold a Personal tenant and be a member of a Business tenant
-- under the same mobile number / email (users_phone_dial_uq / users_email_uq are
-- platform-wide). This migration is PHASE 1 of splitting that apart:
--
--   identities   the person: email, mobile, password, verification state.
--   users        stays the MEMBERSHIP of that person in one tenant (role,
--                account_scope, permissions, company_access — all per-tenant
--                already). It gains `identity_id` and `membership_status`.
--
-- ── PHASE 1 CHANGES NO BEHAVIOUR ─────────────────────────────────────────────
-- `users` remains the source of truth for credentials and every read still goes
-- through it. `identities` is a MIRROR, kept in step by two triggers so that the
-- ~20 write sites (register, activate, reset-password, OTP, erasure, ...) need
-- no edit yet:
--
--   users_identity_insert  BEFORE INSERT: gives the new row an identity
--                          (id = the user's id, exactly as the backfill does).
--   users_identity_sync    AFTER UPDATE OF <credential columns>: copies them.
--
-- Phase 2 moves reads and writes to `identities`, then DROPS both triggers, the
-- legacy credential columns on `users` and the platform-wide unique indexes.
--
-- ── ERROR NAMES ARE PRESERVED ────────────────────────────────────────────────
-- src/lib/dbErrors.ts recognises a duplicate by constraint NAME
-- (users_phone_dial_uq / users_email_uq). The BEFORE INSERT trigger therefore
-- inserts the identity with ON CONFLICT DO NOTHING: when a live identity already
-- holds the number or address, the identity insert is skipped and the users
-- insert goes on to fail on ITS OWN index, with the name the app expects.
--
-- identities carries no tenant_id, so it has no tenant_isolation policy (see
-- GLOBAL_UNPOLICIED_TABLES in tests/rlsCoverage.test.ts). Like `users` at login,
-- it is read before a tenant is known.

CREATE TABLE IF NOT EXISTS "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255),
	"phone_number" varchar(50),
	"phone_dial" varchar(20),
	"password_hash" text NOT NULL,
	"requires_password_change" boolean DEFAULT true NOT NULL,
	"reset_token" varchar(255),
	"reset_token_expiry" timestamp with time zone,
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_verification_otp" varchar(255),
	"email_verification_otp_expiry" timestamp with time zone,
	"phone_verified" boolean DEFAULT false NOT NULL,
	"phone_verification_otp" varchar(255),
	"phone_verification_otp_expiry" timestamp with time zone,
	"consent_data_processing" boolean DEFAULT false NOT NULL,
	"consent_timestamp" timestamp with time zone,
	"consent_ip_address" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identities_phone_dial_uq" ON "identities" ("phone_dial") WHERE phone_dial IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identities_email_uq" ON "identities" ("email") WHERE email IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint

-- NULLABLE on purpose in phase 1: the ~20 insert sites do not set it yet; the
-- BEFORE INSERT trigger below fills it. Phase 2 sets it in code and adds NOT NULL.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "identity_id" uuid REFERENCES "identities"("id");--> statement-breakpoint
-- 'pending' | 'active' | 'declined' | 'removed'. Every existing row is a seat
-- that is already in use, so the default is 'active'.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "membership_status" varchar(16) DEFAULT 'active' NOT NULL;--> statement-breakpoint

-- Backfill: one identity per existing user (soft-deleted rows too, so the
-- erasure / reclaim history keeps a 1:1 shape). identity.id = user.id.
INSERT INTO "identities" (
	"id", "email", "phone_number", "phone_dial", "password_hash", "requires_password_change",
	"reset_token", "reset_token_expiry",
	"email_verified", "email_verification_otp", "email_verification_otp_expiry",
	"phone_verified", "phone_verification_otp", "phone_verification_otp_expiry",
	"consent_data_processing", "consent_timestamp", "consent_ip_address",
	"created_at", "updated_at", "deleted_at"
)
SELECT
	u."id", u."email", u."phone_number", u."phone_dial", u."password_hash", u."requires_password_change",
	u."reset_token", u."reset_token_expiry",
	u."email_verified", u."email_verification_otp", u."email_verification_otp_expiry",
	u."phone_verified", u."phone_verification_otp", u."phone_verification_otp_expiry",
	u."consent_data_processing", u."consent_timestamp", u."consent_ip_address",
	u."created_at", u."updated_at", u."deleted_at"
FROM "users" u
WHERE NOT EXISTS (SELECT 1 FROM "identities" i WHERE i."id" = u."id");--> statement-breakpoint
UPDATE "users" SET "identity_id" = "id" WHERE "identity_id" IS NULL;--> statement-breakpoint

-- users has FORCE ROW LEVEL SECURITY. If this role were subject to it, the two
-- statements above would have matched NOTHING and succeeded silently — fail the
-- migration loudly instead of leaving a half-linked table.
DO $$
DECLARE unlinked integer;
BEGIN
	SELECT count(*) INTO unlinked FROM "users" WHERE "identity_id" IS NULL;
	IF unlinked > 0 THEN
		RAISE EXCEPTION '0081: % users rows have no identity after backfill (RLS hiding rows from the migration role?)', unlinked;
	END IF;
END $$;--> statement-breakpoint

-- One membership per person per tenant. Trivially true while identities are 1:1
-- with users; it is the constraint phase 2 relies on.
CREATE UNIQUE INDEX IF NOT EXISTS "users_identity_tenant_uq" ON "users" ("identity_id", "tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION users_identity_insert() RETURNS trigger AS $$
BEGIN
	IF NEW.identity_id IS NULL THEN
		-- ON CONFLICT DO NOTHING: see "ERROR NAMES ARE PRESERVED" above.
		INSERT INTO identities (
			id, email, phone_number, phone_dial, password_hash, requires_password_change,
			reset_token, reset_token_expiry,
			email_verified, email_verification_otp, email_verification_otp_expiry,
			phone_verified, phone_verification_otp, phone_verification_otp_expiry,
			consent_data_processing, consent_timestamp, consent_ip_address,
			created_at, updated_at, deleted_at
		) VALUES (
			NEW.id, NEW.email, NEW.phone_number, NEW.phone_dial, NEW.password_hash, NEW.requires_password_change,
			NEW.reset_token, NEW.reset_token_expiry,
			NEW.email_verified, NEW.email_verification_otp, NEW.email_verification_otp_expiry,
			NEW.phone_verified, NEW.phone_verification_otp, NEW.phone_verification_otp_expiry,
			NEW.consent_data_processing, NEW.consent_timestamp, NEW.consent_ip_address,
			NEW.created_at, NEW.updated_at, NEW.deleted_at
		) ON CONFLICT DO NOTHING;
		NEW.identity_id := NEW.id;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS users_identity_insert ON "users";--> statement-breakpoint
CREATE TRIGGER users_identity_insert BEFORE INSERT ON "users"
	FOR EACH ROW EXECUTE FUNCTION users_identity_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION users_identity_sync() RETURNS trigger AS $$
BEGIN
	IF NEW.identity_id IS NOT NULL THEN
		UPDATE identities SET
			email = NEW.email,
			phone_number = NEW.phone_number,
			phone_dial = NEW.phone_dial,
			password_hash = NEW.password_hash,
			requires_password_change = NEW.requires_password_change,
			reset_token = NEW.reset_token,
			reset_token_expiry = NEW.reset_token_expiry,
			email_verified = NEW.email_verified,
			email_verification_otp = NEW.email_verification_otp,
			email_verification_otp_expiry = NEW.email_verification_otp_expiry,
			phone_verified = NEW.phone_verified,
			phone_verification_otp = NEW.phone_verification_otp,
			phone_verification_otp_expiry = NEW.phone_verification_otp_expiry,
			consent_data_processing = NEW.consent_data_processing,
			consent_timestamp = NEW.consent_timestamp,
			consent_ip_address = NEW.consent_ip_address,
			updated_at = NEW.updated_at,
			deleted_at = NEW.deleted_at
		WHERE id = NEW.identity_id;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS users_identity_sync ON "users";--> statement-breakpoint
CREATE TRIGGER users_identity_sync AFTER UPDATE OF
	email, phone_number, phone_dial, password_hash, requires_password_change,
	reset_token, reset_token_expiry,
	email_verified, email_verification_otp, email_verification_otp_expiry,
	phone_verified, phone_verification_otp, phone_verification_otp_expiry,
	consent_data_processing, consent_timestamp, consent_ip_address,
	updated_at, deleted_at
	ON "users"
	FOR EACH ROW EXECUTE FUNCTION users_identity_sync();
