-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0060 — drop `users.consent_ai_processing`                               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The register form asked for two consents side by side: one for storing the
-- person's data, one for sending their records to Gemini/OpenAI. The second is
-- gone from the form, and this removes the column behind it.
--
-- ── NOTHING READ IT ────────────────────────────────────────────────────────
-- The flag was written once, at registration, and never consulted again: no AI
-- route, no prompt builder, no analysis helper and no Drive sync branched on
-- it. `prepareAiPayload` (AGENTS.md §11) is what actually governs what leaves
-- this system for a model, and it applies to every tenant unconditionally.
--
-- ── THIS DESTROYS A CONSENT RECORD. DELIBERATELY ───────────────────────────
-- The column WAS the only stored evidence that each user agreed to AI
-- processing, and once dropped it cannot be reconstructed — a restored row
-- would only ever be the column default. The remaining DPDPA record survives
-- intact: `consent_data_processing`, `consent_timestamp` and
-- `consent_ip_address` are untouched, and the register form still refuses to
-- create an account without that consent ticked.
--
-- Take a dump of `users` before running this anywhere with real accounts in it.
--
-- ── DEPLOY ORDER MATTERS ───────────────────────────────────────────────────
-- Drizzle's `users` model names every column explicitly, so the OLD build
-- SELECTs `consent_ai_processing` on every user read. Ship the code that no
-- longer has the column in its schema FIRST, then run this. The reverse order
-- is a login outage.

-- ── 1. Say what is being thrown away ───────────────────────────────────────
-- Not a guard — nothing here can refuse the drop, and no count would be a
-- reason to. It puts the numbers in the migration log, which is the last place
-- they will ever appear.
DO $$
DECLARE consented integer; total integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'consent_ai_processing'
  ) THEN
    SELECT count(*) FILTER (WHERE consent_ai_processing), count(*)
      INTO consented, total FROM users;
    RAISE NOTICE 'dropping consent_ai_processing — % of % users had it set', consented, total;
  END IF;
END $$;--> statement-breakpoint

-- ── 2. The column ──────────────────────────────────────────────────────────
-- IF EXISTS because a database rebuilt from a later baseline never had it.
ALTER TABLE "users" DROP COLUMN IF EXISTS "consent_ai_processing";--> statement-breakpoint

-- ── 3. Prove it, and prove the rest of the consent record survived ─────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'users' AND column_name = 'consent_ai_processing';
  IF n > 0 THEN RAISE EXCEPTION 'consent_ai_processing survived the drop'; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'users'
     AND column_name IN ('consent_data_processing', 'consent_timestamp', 'consent_ip_address');
  IF n <> 3 THEN RAISE EXCEPTION 'the surviving consent columns are not all there (% of 3)', n; END IF;
END $$;

-- POST-CHECK:
--   SELECT consent_data_processing, consent_timestamp IS NOT NULL AS ts
--     FROM users WHERE role = 'TENANT_ADMIN' LIMIT 5;
--   -- expect t / t, and \d users to show no consent_ai_processing
