-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0078 — Reconcile each tenant's credit ledger with its balance           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The admin Tenants card now reads "490 left · of 2,000 received · 1,630 used",
-- from `credit_transactions`. That only reads right when the ledger adds up to
-- `tenants.ai_credits_balance`. Some did not:
--   • credits a tenant held before the ledger recorded every movement, and
--   • concurrent Power Scans (25 Sep) recorded as −20/−30 when each deducted 10 —
--     the read-before-write race now closed by lockTenantRow in
--     src/lib/planProvisioning.ts.
--
-- One compensating row per tenant whose ledger is off, for exactly the gap, so
-- that received − used = balance. The BALANCE IS NOT CHANGED — this only makes
-- the history explain it. Append-only, like every other correction to this
-- ledger; reason `admin_adjust` ("Admin adjustment" on /billing/credits).
--
-- Idempotent: after it runs every ledger nets to its balance, so a re-run
-- finds no gap and inserts nothing.
INSERT INTO "credit_transactions"
  ("tenant_id", "user_id", "company_id", "amount", "balance_after", "reason", "description", "created_at")
SELECT
  t.id,
  NULL,
  NULL,
  t.ai_credits_balance - COALESCE(l.net, 0),
  t.ai_credits_balance,
  'admin_adjust',
  'Ledger correction — '
    || CASE WHEN t.ai_credits_balance - COALESCE(l.net, 0) > 0
            THEN 'credits held but never recorded in this history (earlier grants, or Power Scans run at the same moment recorded at more than they cost)'
            ELSE 'credits deducted but never recorded in this history'
       END
    || '. Balance unchanged.',
  now()
FROM "tenants" t
LEFT JOIN (
  SELECT tenant_id, SUM(amount)::int AS net FROM "credit_transactions" GROUP BY tenant_id
) l ON l.tenant_id = t.id
WHERE t.ai_credits_balance <> COALESCE(l.net, 0);
