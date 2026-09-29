---
description: Scan API routes & lib for tenant-isolation violations (missing withTenant / tenantId).
argument-hint: "[optional path, defaults to src/app/api]"
allowed-tools: Bash(grep:*), Bash(rg:*), Bash(git diff:*), Read, Grep, Glob, Task
---

Audit ${ARGUMENTS:-src/app/api and src/lib} for multi-tenant isolation defects.
Follow the `tenant-isolation` skill.

Steps:
1. Enumerate route handlers and any `src/lib` code that reads/writes tenant tables
   (documents, medical_records, passwords, bank_info, trading, investments,
   vehicles, lic_mediclaim, loans, rentals, utility_bills, warranty, wills, etc.).
2. For each data-access call, verify BOTH guards are present:
   - runs inside `withTenant(user.tenantId, …)`, and
   - the `where` includes `eq(table.tenantId, user.tenantId)` and, on reads,
     `isNull(table.deletedAt)`.
3. Flag any of these anti-patterns with `file:line`:
   - bare `db.query/select/insert/update/delete` on a tenant table (not `tx`
     inside `withTenant`);
   - a `where` missing the `tenantId` predicate;
   - scoping by a `tenantId`/`userId` taken from `req` body/query/params instead
     of the authenticated `user`;
   - `[id]` route not filtered by tenantId (IDOR);
   - missing 401 (`getUserFromRequest`) or 403 (`hasPermission`) gate.
4. Produce a table: `file:line | route/fn | issue | suggested fix`, most severe
   first. If everything is clean, say so and list what you checked.

For a deeper review of the flagged files, hand off to the `security-auditor` agent.
