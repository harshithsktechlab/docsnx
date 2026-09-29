# Follow-up: Tenant isolation is app-layer only (RLS not enabled)

**Logged:** 2026-07-23 · **Severity:** High (defense-in-depth gap, not an active leak) · **Status:** Open

## Summary
Postgres Row-Level Security (RLS) is **not enabled on any table** in the running
(dev) database — `0 of 39` tables. Tenant isolation currently rests **entirely on
the application-layer `eq(table.tenantId, user.tenantId)` predicate** in each
route. The `withTenant()` wrapper (which sets the `app.tenant_id` session var RLS
policies read) is used by only **6** route files; **52** route files query
tenant-scoped tables with the bare `db` client.

This is a defense-in-depth gap: if any single route forgets its `tenantId`
predicate (or a future bug drops it), there is **no database-level backstop** to
prevent cross-tenant data access. AGENTS.md §6 mandates both layers.

## Why it's currently this way (root cause)
The database was provisioned with `drizzle-kit push`, which applies only the
schema in `src/db/schema.ts`. The RLS enablement + policies live in hand-written
migration SQL (`0003_enable_rls.sql`, `0005_rls_policies.sql`) that `push` never
runs. So the policies were authored but never applied here, and most routes were
written against the bare `db` client instead of `withTenant`.

## Evidence
- `SELECT count(*) FROM pg_class WHERE relrowsecurity` → 0 tables with RLS.
- 6 route files use `withTenant`; 52 do not (list below).
- The preserved policy SQL is in `docs/security/0003_enable_rls.sql` and
  `docs/security/0005_rls_policies.sql` (copied here before the migration
  baseline-reset; also in git history under `drizzle/`).

## New tenant tables that never had a policy even in the old migrations
These need a `tenant_isolation` policy added when RLS work happens:
`credit_cards, loans_debts, tax_compliances, wills_estates, utility_bills,
corporate_compliances, employment_payrolls, user_devices, tenant_addons,
discount_usages`.

Standard policy (mirror `docs/security/0005_rls_policies.sql`):
```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON <t>
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
EXCEPTION WHEN duplicate_object THEN null; END $$;
```

## Recommended remediation (do NOT half-do — RLS FORCE fails closed)
Enabling RLS before the routes use `withTenant` will **break** every bare-`db`
route (query errors on unset `app.tenant_id`). Sequence it:

1. **Refactor routes to `withTenant`** — wrap every tenant-table read/write in
   `withTenant(user.tenantId, async (tx) => …)` and switch `db.*` → `tx.*`. Go
   module by module; the `.claude/skills/tenant-isolation` + `api-route-pattern`
   skills describe the exact shape, and `src/app/api/passwords/route.ts` is a
   correct reference. Verify each module in the browser after converting.
2. **Apply RLS to ALL tenant tables** — run the preserved `0003`/`0005` policy SQL
   plus the 10 new tables above (as a new migration, e.g. `0001_enable_rls.sql`
   on top of the baseline).
3. **Test** — for each module, confirm a tenant-A session cannot read/write
   tenant-B rows even with a forged id; add regression tests via the
   `.claude/agents/test-engineer` agent.

Use `/tenant-audit` (added in `.claude/commands`) to re-scan, and the
`security-auditor` agent to review each converted module.

## The 52 routes bypassing `withTenant` (regenerate with the grep below)
```
account/delete, account/export, admin/dashboard/summary, admin/payments,
admin/tenants, admin/tenants/[id]/addons, ai/scan/save, analysis, backup,
corporate-compliance, credit-cards, credit-cards/[id], dashboard,
dashboard/growth, documents, documents/[id], emergency-contacts,
emergency-contacts/[id], employment-payroll, follow-up, follow-up/count,
investments, investments/[id], investments/[id]/generate-followups, lic-mediclaim,
lic-mediclaim/[id], loans-debt, medical, medical/[id], notifications,
notifications/[id], payments/create-order, payments/validate-discount,
payments/verify, rentals, rentals/[id], search, tax-compliance, todos, todos/[id],
trading, trading/[id], utility-bills, v1/devices/register, vehicles,
vehicles/[id], vehicles/[id]/generate-followups, warranty, warranty/[id],
webhooks/razorpay, wills-estate
```
Regenerate the current list:
```bash
for f in $(grep -rlE 'documents|passwords|bankInfos|creditCards|tradingDemats|vehicles|licMediclaims|investments|loansDebts|taxCompliances|willsEstates|utilityBills|corporateCompliances|employmentPayrolls|todos|notifications|emergencyContacts|warrantyAmcs' src/app/api --include=route.ts); do
  grep -q withTenant "$f" || echo "$f"
done
```
> Note: `webhooks/razorpay`, some `admin/*`, and `payments/*` routes are
> platform/cross-tenant by design — review whether they should stay bare `db`
> (SUPER_ADMIN / signed-webhook context) rather than `withTenant`.
