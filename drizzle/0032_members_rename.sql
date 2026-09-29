-- ═══════════════════════════════════════════════════════════════════════════
--  0032 — "family members" becomes "members".
--
--  docsnx grew out of a family-office concept and the word leaked everywhere,
--  including into three seat-count columns. A tenant is a workspace now — the
--  admin console has always offered "Sharma Household or Acme Corp" — so the
--  schema says `members`, matching the rest of the vocabulary (tenant, member,
--  workspace) and the renamed /api/members route.
--
--  PURE RENAME — no table rewrite, no backfill, no default or nullability
--  change. `ALTER TABLE … RENAME COLUMN` is a catalog update: it takes an
--  ACCESS EXCLUSIVE lock for the duration of a system-catalog write, which on
--  these three tables is microseconds.
--
--  No RLS change. None of these columns appears in a policy predicate — the
--  policies in scripts/apply-rls.js match on `tenant_id` only — so the rename
--  cannot invalidate one. `tenants` is not itself an RLS table.
--
--  ── DEPLOY ORDER MATTERS ──────────────────────────────────────────────────
--  The running build selects these columns BY NAME. Build the new code first,
--  then migrate, then restart, so the window in which the old process queries
--  a column that no longer exists is seconds rather than minutes. There is no
--  down migration; the reverse RENAME is four lines if it is ever needed.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "tenants" RENAME COLUMN "max_family_members" TO "max_members";
--> statement-breakpoint
ALTER TABLE "tenants" RENAME COLUMN "extra_family_members" TO "extra_members";
--> statement-breakpoint
ALTER TABLE "subscription_plans" RENAME COLUMN "max_family_members" TO "max_members";
--> statement-breakpoint
ALTER TABLE "addons" RENAME COLUMN "extra_family_members" TO "extra_members";
