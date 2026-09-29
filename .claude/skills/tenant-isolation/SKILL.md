---
name: tenant-isolation
description: >-
  How docsnx enforces multi-tenant data isolation. Read this BEFORE writing or
  reviewing ANY database query, API route, or background job that touches a
  tenant-scoped table (documents, medical_records, passwords, bank_info, trading,
  investments, vehicles, etc.). Covers the withTenant + Postgres RLS mechanism,
  the mandatory tenantId predicate, soft-delete filtering, and the request-tenant
  trust rule. Triggers on: "tenant", "tenantId", "withTenant", "RLS", "isolation",
  "db.query", "leak between tenants".
---

# Tenant isolation (docsnx)

docsnx is multi-tenant. Cross-tenant data access is a **critical** incident.
Isolation is enforced at **two layers that must BOTH be present** — this
redundancy is deliberate.

## Layer 1 — Postgres RLS via `withTenant`
`src/lib/db.ts` exposes `withTenant(tenantId, callback)`. It opens a transaction
and runs `SELECT set_config('app.tenant_id', <tenantId>, true)` so RLS policies
keyed on `app.tenant_id` filter rows at the database level.

```ts
const result = await withTenant(user.tenantId, async (tx) => {
  return tx.query.passwords.findMany({ where: whereClause });
});
```

Rules:
- Every read/write on a tenant-scoped table runs **inside** `withTenant`. Never
  use the bare `db` for tenant data.
- `withTenant` throws if `tenantId` is falsy — good, don't swallow it.

## Layer 2 — explicit `tenantId` predicate
Even inside `withTenant`, add the tenant filter to the `where` (defense in depth
in case an RLS policy is missing on a new table):

```ts
const conditions = [
  eq(passwords.tenantId, user.tenantId),
  isNull(passwords.deletedAt),          // soft delete — always exclude deleted
];
if (category) conditions.push(eq(passwords.category, category));
const whereClause = and(...conditions);
```

## The golden rule: tenant comes from the SESSION, never the request
Derive `tenantId` (and generally `userId` for ownership) from the authenticated
`user` returned by `getUserFromRequest`. NEVER scope by a `tenantId`/`userId`
sent in the request body, query string, or route params — a malicious tenant
will supply another tenant's id.

```ts
// ✅ correct
eq(passwords.tenantId, user.tenantId)
// ❌ NEVER
eq(passwords.tenantId, body.tenantId)
```

## `[id]` (detail/update/delete) routes
Scope by BOTH id and tenant so a guessed UUID can't cross tenants (IDOR):

```ts
where: and(eq(passwords.id, params.id), eq(passwords.tenantId, user.tenantId), isNull(passwords.deletedAt))
```
For delete, prefer a soft delete (`set deletedAt = now()`), still tenant-scoped.

## Self-audit checklist before you finish
- [ ] Every tenant-table access is inside `withTenant(user.tenantId, …)`.
- [ ] Every `where` has `eq(table.tenantId, user.tenantId)`.
- [ ] `isNull(table.deletedAt)` present on reads.
- [ ] No `tenantId`/`userId` used for scoping came from the request payload.
- [ ] `[id]` routes filter by id AND tenantId.
- [ ] New tenant tables have an RLS policy + `tenantId` index (see the
      `drizzle-migrator` agent).

When in doubt, copy `src/app/api/passwords/route.ts`. For a deep audit, run the
`security-auditor` agent or `/tenant-audit`.
