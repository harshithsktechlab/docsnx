-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0082 — one person, many tenants: credentials shared across memberships  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- PHASE 2 of the identities split (0081 was phase 1). After this a person
-- (identities row) can hold several `users` rows — one per tenant — and
-- sign-in credentials are ONE thing across all of them.
--
-- ── THE MODEL, AND WHY THE COLUMNS ARE STILL ON `users` ──────────────────────
-- `identities` is the authority for the person's email, mobile, password and
-- verification state. The same columns REMAIN on every `users` row as a copy,
-- kept identical by the triggers below, because ~100 reads across the app take
-- them from the user row (getUserFromRequest, otpChallenge, verificationChannels,
-- rosters, billing contacts...). Keeping the copy means none of those change and
-- none can drift: a write to any membership's copy fans out to the identity and
-- to every sibling membership inside the same statement.
--
--   users_identity_insert  BEFORE INSERT
--       identity_id NULL   -> a NEW person: refuse a contact a live identity
--                             already holds (under the old users_* constraint
--                             names), then create the identity (id = user id).
--       identity_id given  -> an EXISTING person gains a seat: the row is forced
--                             to carry the identity's credentials, whatever the
--                             caller put in the INSERT. Nobody can attach a seat
--                             with a different password or contact.
--   users_identity_sync    AFTER UPDATE OF <credential columns>
--       live row           -> push to the identity and to every live sibling.
--       row just deleted   -> push NOTHING (a removed seat's tombstoned email must
--                             never reach the person), and soft-delete the
--                             identity only if that was its last live seat.
--   users_identity_delete  AFTER DELETE
--       last seat hard-deleted (erasure, tenant cascade) -> delete the identity,
--       so erased PII does not linger and the number is free again.
--
-- ── WHAT THIS DELIBERATELY DOES NOT PROTECT ──────────────────────────────────
-- The DB cannot tell WHO is editing. A tenant admin editing a member's password,
-- email or mobile would now change the person's sign-in for EVERY tenant. That
-- is refused in application code (src/lib/account/sharedIdentity.ts) at the
-- admin routes; only the person themself may change them.
--
-- ── ERROR NAMES ARE PRESERVED ────────────────────────────────────────────────
-- src/lib/dbErrors.ts recognises duplicates by constraint NAME. Every
-- uniqueness failure raised here carries users_phone_dial_uq / users_email_uq.
--
-- users_phone_dial_uq / users_email_uq (platform-wide on `users`) are dropped:
-- uniqueness now lives on identities (identities_*_uq) and, per tenant, on
-- users_identity_tenant_uq (0081). Plain partial indexes replace them for lookup.

DROP INDEX IF EXISTS "users_phone_dial_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "users_email_uq";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_phone_dial_idx" ON "users" ("phone_dial") WHERE phone_dial IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users" ("email") WHERE email IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION users_identity_insert() RETURNS trigger AS $$
DECLARE
	ident identities%ROWTYPE;
	cname text;
BEGIN
	IF NEW.identity_id IS NOT NULL THEN
		SELECT * INTO ident FROM identities WHERE id = NEW.identity_id AND deleted_at IS NULL;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'users.identity_id % does not name a live identity', NEW.identity_id
				USING ERRCODE = 'foreign_key_violation';
		END IF;
		NEW.email := ident.email;
		NEW.phone_number := ident.phone_number;
		NEW.phone_dial := ident.phone_dial;
		NEW.password_hash := ident.password_hash;
		NEW.requires_password_change := ident.requires_password_change;
		NEW.reset_token := ident.reset_token;
		NEW.reset_token_expiry := ident.reset_token_expiry;
		NEW.email_verified := ident.email_verified;
		NEW.email_verification_otp := ident.email_verification_otp;
		NEW.email_verification_otp_expiry := ident.email_verification_otp_expiry;
		NEW.phone_verified := ident.phone_verified;
		NEW.phone_verification_otp := ident.phone_verification_otp;
		NEW.phone_verification_otp_expiry := ident.phone_verification_otp_expiry;
		RETURN NEW;
	END IF;

	IF NEW.deleted_at IS NULL THEN
		IF NEW.phone_dial IS NOT NULL AND EXISTS (
			SELECT 1 FROM identities WHERE phone_dial = NEW.phone_dial AND deleted_at IS NULL
		) THEN
			RAISE EXCEPTION 'duplicate key value violates unique constraint "users_phone_dial_uq"'
				USING ERRCODE = 'unique_violation', CONSTRAINT = 'users_phone_dial_uq';
		END IF;
		IF NEW.email IS NOT NULL AND EXISTS (
			SELECT 1 FROM identities WHERE email = NEW.email AND deleted_at IS NULL
		) THEN
			RAISE EXCEPTION 'duplicate key value violates unique constraint "users_email_uq"'
				USING ERRCODE = 'unique_violation', CONSTRAINT = 'users_email_uq';
		END IF;
	END IF;

	BEGIN
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
		);
	EXCEPTION WHEN unique_violation THEN
		-- Two concurrent first-time inserts: the second loses on the identity index.
		GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
		RAISE EXCEPTION 'duplicate key value violates unique constraint "%"', cname
			USING ERRCODE = 'unique_violation',
				CONSTRAINT = CASE cname
					WHEN 'identities_phone_dial_uq' THEN 'users_phone_dial_uq'
					WHEN 'identities_email_uq' THEN 'users_email_uq'
					ELSE cname
				END;
	END;
	NEW.identity_id := NEW.id;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION users_identity_sync() RETURNS trigger AS $$
DECLARE
	cname text;
BEGIN
	-- The sibling UPDATE below fires this trigger again (depth 2): stop it there.
	IF pg_trigger_depth() > 1 OR NEW.identity_id IS NULL THEN
		RETURN NULL;
	END IF;

	IF NEW.deleted_at IS NOT NULL THEN
		IF OLD.deleted_at IS NULL AND NOT EXISTS (
			SELECT 1 FROM users
			 WHERE identity_id = NEW.identity_id AND id <> NEW.id AND deleted_at IS NULL
		) THEN
			UPDATE identities SET deleted_at = NEW.deleted_at, updated_at = NEW.updated_at
			 WHERE id = NEW.identity_id;
		END IF;
		RETURN NULL;
	END IF;

	BEGIN
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
			deleted_at = NULL
		WHERE id = NEW.identity_id;
	EXCEPTION WHEN unique_violation THEN
		GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
		RAISE EXCEPTION 'duplicate key value violates unique constraint "%"', cname
			USING ERRCODE = 'unique_violation',
				CONSTRAINT = CASE cname
					WHEN 'identities_phone_dial_uq' THEN 'users_phone_dial_uq'
					WHEN 'identities_email_uq' THEN 'users_email_uq'
					ELSE cname
				END;
	END;

	UPDATE users SET
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
		phone_verification_otp_expiry = NEW.phone_verification_otp_expiry
	WHERE identity_id = NEW.identity_id
	  AND id <> NEW.id
	  AND deleted_at IS NULL
	  AND (
		email IS DISTINCT FROM NEW.email
		OR phone_number IS DISTINCT FROM NEW.phone_number
		OR phone_dial IS DISTINCT FROM NEW.phone_dial
		OR password_hash IS DISTINCT FROM NEW.password_hash
		OR requires_password_change IS DISTINCT FROM NEW.requires_password_change
		OR reset_token IS DISTINCT FROM NEW.reset_token
		OR reset_token_expiry IS DISTINCT FROM NEW.reset_token_expiry
		OR email_verified IS DISTINCT FROM NEW.email_verified
		OR email_verification_otp IS DISTINCT FROM NEW.email_verification_otp
		OR email_verification_otp_expiry IS DISTINCT FROM NEW.email_verification_otp_expiry
		OR phone_verified IS DISTINCT FROM NEW.phone_verified
		OR phone_verification_otp IS DISTINCT FROM NEW.phone_verification_otp
		OR phone_verification_otp_expiry IS DISTINCT FROM NEW.phone_verification_otp_expiry
	  );
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION users_identity_delete() RETURNS trigger AS $$
BEGIN
	IF OLD.identity_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM users WHERE identity_id = OLD.identity_id
	) THEN
		DELETE FROM identities WHERE id = OLD.identity_id;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS users_identity_delete ON "users";--> statement-breakpoint
CREATE TRIGGER users_identity_delete AFTER DELETE ON "users"
	FOR EACH ROW EXECUTE FUNCTION users_identity_delete();
