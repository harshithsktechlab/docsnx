---
description: Scaffold a new tenant-scoped record-vault module (schema + API route + tests) to house conventions.
argument-hint: "<module-name> (e.g. insurance-claims)"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(npx drizzle-kit generate:*), Bash(npx tsc:*), Bash(npm run lint:*), Bash(npx vitest:*), Task
---

Scaffold a new record-vault module named **$ARGUMENTS** end-to-end, following all
docsnx conventions. Do not skip the security wiring.

Plan and execute:
1. **Confirm shape** — ask (only if unclear) which fields the module needs and
   which are sensitive (encrypted) vs plain vs lookup (blind-indexed).
2. **Schema** (`src/db/schema.ts`) — hand off to the `drizzle-migrator` agent to
   add the table: `id` uuid PK, `tenantId` (FK→tenants, notNull, indexed),
   `userId`, audit timestamps, `deletedAt`, sensitive columns as ciphertext text
   (+ `*_hash` blind-index companions where lookups are needed), and the `relations(...)` block.
   Then `npx drizzle-kit generate` and review the SQL (add the RLS policy).
3. **API route** (`src/app/api/<module>/route.ts` and `[id]/route.ts`) — hand off
   to the `api-route-builder` agent, following the `api-route-pattern` and
   `field-encryption` skills (auth → permission → zod → withTenant → encrypt →
   audit → strip secrets, soft-delete, pagination).
4. **Register** the module wherever the app enumerates modules (e.g.
   `src/lib/moduleRegistry.js`, permissions, nav) — grep for how an existing
   module like `passwords` is registered and mirror it.
5. **Tests** — hand off to the `test-engineer` agent for a tenant-isolation
   regression test, a permission-matrix test, and a credential-non-exposure test.
6. **Verify** — `npx tsc --noEmit`, `npm run lint`, run the new tests, then run
   the `security-auditor` agent on the new files. Summarize what was created and
   the exact follow-up commands (migrate, etc.).
