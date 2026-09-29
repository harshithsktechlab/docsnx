-- ═══════════════════════════════════════════════════════════════════════════
--  Drop the fifteen per-module record tables.
--
--  Their records are `documents` rows now. Every route, the bulk-scan importer,
--  follow-up, search, dashboard, backup, the DPDPA export and the admin console
--  read and write `documents`; nothing in src/ imports these tables any more.
--
--  ⚠ IRREVERSIBLE. Verified empty immediately before writing this migration,
--  and the guard below re-checks at APPLY time — a table that gained a row
--  between then and now aborts the whole thing rather than destroying it.
--
--  ── WHY THIS IS A SECURITY IMPROVEMENT, NOT ONLY A TIDY-UP ────────────────
--  Seven of these tables had NO row-level-security policy at all:
--    tax_compliances, wills_estates, loans_debts, utility_bills,
--    corporate_compliances, employment_payrolls, credit_cards
--  They were tenant-scoped in the schema and unprotected in the database. They
--  cannot be fixed and cannot be forgotten again, because they are gone; their
--  records live in `documents`, which carries ENABLE + FORCE ROW LEVEL SECURITY
--  and a tenant_isolation policy.
--
--  ── ORDER MATTERS ─────────────────────────────────────────────────────────
--  scripts/apply-rls.js must have these names removed from its list BEFORE this
--  runs. It applies every policy in ONE transaction, so a CREATE POLICY against
--  a missing relation rolls back every other policy too — the failure mode is
--  not "one table unprotected", it is "no table protected".
--
--  No CASCADE: nothing references any of them. Verified — no `references(() =>
--  <table>.id)` anywhere in src/db/schema.ts, and no inbound FK in pg_constraint.
--
--  Hand-written; forward-only.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Refuse to destroy data ───────────────────────────────────────────────
DO $$
DECLARE
  t text;
  n bigint;
  offenders text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'medical_records','vehicles','lic_mediclaims','warranty_amcs','contract_agreements',
    'tax_compliances','wills_estates','loans_debts','utility_bills','corporate_compliances',
    'employment_payrolls','bank_infos','credit_cards','trading_demats','investments'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n > 0 THEN offenders := offenders || format('%s=%s ', t, n); END IF;
  END LOOP;

  IF offenders <> '' THEN
    RAISE EXCEPTION
      'Refusing to drop non-empty record tables: %. Migrate these rows into `documents` first.',
      offenders;
  END IF;
END $$;--> statement-breakpoint

-- ── 1. Nothing may still point at them ─────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM pg_constraint c
    JOIN pg_class ref ON ref.oid = c.confrelid
   WHERE c.contype = 'f'
     AND ref.relname IN (
       'medical_records','vehicles','lic_mediclaims','warranty_amcs','contract_agreements',
       'tax_compliances','wills_estates','loans_debts','utility_bills','corporate_compliances',
       'employment_payrolls','bank_infos','credit_cards','trading_demats','investments');
  IF n > 0 THEN
    RAISE EXCEPTION '% foreign keys still reference these tables; DROP would need CASCADE', n;
  END IF;
END $$;--> statement-breakpoint

-- ── 2. Drop ─────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "medical_records";--> statement-breakpoint
DROP TABLE IF EXISTS "vehicles";--> statement-breakpoint
DROP TABLE IF EXISTS "lic_mediclaims";--> statement-breakpoint
DROP TABLE IF EXISTS "warranty_amcs";--> statement-breakpoint
DROP TABLE IF EXISTS "contract_agreements";--> statement-breakpoint
DROP TABLE IF EXISTS "tax_compliances";--> statement-breakpoint
DROP TABLE IF EXISTS "wills_estates";--> statement-breakpoint
DROP TABLE IF EXISTS "loans_debts";--> statement-breakpoint
DROP TABLE IF EXISTS "utility_bills";--> statement-breakpoint
DROP TABLE IF EXISTS "corporate_compliances";--> statement-breakpoint
DROP TABLE IF EXISTS "employment_payrolls";--> statement-breakpoint
DROP TABLE IF EXISTS "bank_infos";--> statement-breakpoint
DROP TABLE IF EXISTS "credit_cards";--> statement-breakpoint
DROP TABLE IF EXISTS "trading_demats";--> statement-breakpoint
DROP TABLE IF EXISTS "investments";--> statement-breakpoint

-- ── 3. Verify ───────────────────────────────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename IN (
       'medical_records','vehicles','lic_mediclaims','warranty_amcs','contract_agreements',
       'tax_compliances','wills_estates','loans_debts','utility_bills','corporate_compliances',
       'employment_payrolls','bank_infos','credit_cards','trading_demats','investments');
  IF n > 0 THEN RAISE EXCEPTION '% of the record tables survived the drop', n; END IF;

  -- The survivor must still be protected.
  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename = 'documents' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN RAISE EXCEPTION 'documents lost its tenant_isolation policy'; END IF;
END $$;

-- POST-MIGRATION: node scripts/apply-rls.js   (its list must already be trimmed)
-- POST-CHECK:     SELECT count(*) FROM pg_tables WHERE schemaname='public';   -- 29
