import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Every tenant-scoped table must be registered in scripts/apply-rls.js.
 *
 * A tenant-scoped table with no policy is a silent isolation hole: it looks
 * correct in the schema, passes every unit test, and leaks across tenants the
 * moment a query forgets its explicit `tenantId` predicate. Nothing else in the
 * suite would notice, because RLS is the backstop for exactly the case where
 * the predicate was missed.
 *
 * KNOWN_UNREGISTERED records tables that predate this check. They are NOT
 * endorsed — the list exists so the gap is visible and cannot grow silently.
 * Registering one of them should mean deleting it from this list, never adding
 * a new entry.
 */

const SCHEMA_PATH = path.join(__dirname, '..', 'src', 'db', 'schema.ts');
const RLS_PATH = path.join(__dirname, '..', 'scripts', 'apply-rls.js');

/**
 * Tenant-scoped tables that had no RLS policy when this check was introduced
 * (2026-08-05, alongside the vault work). Pre-existing debt, not a decision.
 *
 * SEVEN entries left when migration 0019 dropped the per-module record tables:
 * credit_cards, tax_compliances, wills_estates, loans_debts, utility_bills,
 * corporate_compliances and employment_payrolls were all unprotected, and are
 * now gone — their records are `documents` rows, and `documents` carries a
 * policy. The debt was repaid by deletion rather than by adding seven policies.
 */
const KNOWN_UNREGISTERED = new Set([
  'tenant_addons',
  'invoices',
  'ai_analysis_cache',
  'discount_usages',
  'user_devices',
]);

/**
 * Tenant-scoped tables that are unpolicied BY DESIGN, not by debt. Distinct
 * from KNOWN_UNREGISTERED above, which is a list that should only ever shrink.
 *
 * `deleted_accounts` holds the name/phone/email of the members of a workspace
 * that has been ERASED, and it is the only thing that survives that erasure.
 * The standard policy `tenant_id = current_setting('app.tenant_id')::uuid`
 * could never match one of its rows: by the time a row exists its tenant does
 * not, so no session can set app.tenant_id to that value and the table would
 * read as permanently empty — including for the compliance query it exists to
 * serve. Its protection is that `name` and `phone_number` are encryptField()
 * ciphertext, and that its ONE reader — `findErasedAccount`
 * (src/lib/account/erasedAccountLookup.ts), which login and forgot-password
 * consult on a miss so a person can be told their account was erased — selects
 * only `erased_at`, `role` and `tenant_name`, by an indexed key.
 */
const DELIBERATELY_UNPOLICIED = new Set([
  'deleted_accounts',
]);

/** Tables the vault introduced. These must always be registered. */
const VAULT_TENANT_TABLES = [
  'tenant_encryption_keys',
  'user_vault_keys',
  'vault_json_files',
] as const;

/**
 * Reference tables that are GLOBAL — no tenant_id at all, so no RLS policy.
 * Registering one would create a policy over a missing column, which fails at
 * CREATE POLICY time and rolls back all of apply-rls.js.
 */
const GLOBAL_UNPOLICIED_TABLES = [
  'document_categories',      // tenant_id dropped in drizzle/0006
  'document_category_fields', // tenant_id dropped in drizzle/0008
  // Operator overrides for the above. Global for the same reason its parent is:
  // the taxonomy is identical for every tenant and a super admin is a platform
  // role, so there is no tenant column to write a policy over.
  'document_category_field_overrides', // added in drizzle/0037
] as const;

function readSchema(): string {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

function readRlsScript(): string {
  return fs.readFileSync(RLS_PATH, 'utf8');
}

/** Every pgTable definition that declares a tenant_id column. */
function tenantScopedTablesInSchema(): string[] {
  const schema = readSchema();
  const tables: string[] = [];
  for (const match of schema.matchAll(/pgTable\("([a-z_]+)"[\s\S]*?\n\}\)/g)) {
    if (/tenant_id/.test(match[0])) tables.push(match[1]);
  }
  return tables;
}

/** Table names listed in either array in apply-rls.js. */
function registeredTables(): Set<string> {
  const script = readRlsScript();
  return new Set([...script.matchAll(/^\s*'([a-z_]+)',?\s*$/gm)].map((m) => m[1]));
}

describe('vault tables', () => {
  it.each(VAULT_TENANT_TABLES)('registers %s for tenant isolation', (table) => {
    expect(registeredTables().has(table)).toBe(true);
  });

  it.each(GLOBAL_UNPOLICIED_TABLES)('does NOT register %s — it has no tenant_id', (table) => {
    // A policy referencing a dropped column fails at CREATE POLICY time and
    // would take the whole apply-rls transaction down with it.
    expect(registeredTables().has(table)).toBe(false);
  });

  it.each(GLOBAL_UNPOLICIED_TABLES)('declares %s without a tenant_id column', (table) => {
    // The other half of the pair: if someone re-adds tenant_id to one of these,
    // the test above stops being the safeguard it looks like — the table would
    // then need a policy and silently have none.
    const schema = readSchema();
    const block = schema.match(new RegExp(`pgTable\\("${table}"[\\s\\S]*?\\n\\}\\)`))?.[0] ?? '';
    expect(block, `${table} was not found in schema.ts`).not.toBe('');
    expect(block).not.toMatch(/tenant_id/);
  });

  it('keeps the hybrid policy asymmetric — everyone reads global rows, nobody writes one', () => {
    // hybridGlobalTenantTables is empty today, but the loop that consumes it
    // must keep the asymmetry for the next table that needs the shape.
    const script = readRlsScript();
    expect(script).toContain('tenant_id IS NULL OR tenant_id = current_setting');
    expect(script).toContain('WITH CHECK (tenant_id = current_setting');
  });
});

describe('the business account tables', () => {
  it('registers companies for tenant isolation', () => {
    // Caught by the generic sweep too, since it carries a tenant_id — this
    // states the intent rather than relying on the sweep to notice.
    expect(readRlsScript()).toMatch(/'companies'/);
  });

  it('registers company_access as USER-scoped, which no sweep can catch', () => {
    // `company_access` has no tenant_id of its own — it is scoped through
    // `user_id -> users`, like `permissions` — so the "unregistered
    // tenant-scoped table" guard below cannot see it at all. Removing it from
    // `userScopedTables` would silently drop the policy on the table that gates
    // every business record, and nothing else in the suite would notice.
    const src = readRlsScript();
    const userScoped = /const userScopedTables = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
    expect(userScoped, 'company_access lost its RLS policy').toContain("'company_access'");
    expect(userScoped).toContain("'permissions'");
  });

  it('keeps company_access out of the tenant-scoped list, where it would fail', () => {
    // Listing it there would emit `CREATE POLICY ... USING (tenant_id = ...)`
    // over a column that does not exist. The whole script runs in one
    // transaction, so that one failure rolls back EVERY policy — the exact
    // outage the file header records happening once already.
    const src = readRlsScript();
    const tenantScoped = /const tenantScopedTables = \[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
    expect(tenantScoped).not.toContain("'company_access'");
  });
});

describe('schema-wide coverage', () => {
  it('has no NEW unregistered tenant-scoped table', () => {
    const registered = registeredTables();
    const unregistered = tenantScopedTablesInSchema().filter((t) => !registered.has(t));
    const unexpected = unregistered.filter(
      (t) => !KNOWN_UNREGISTERED.has(t) && !DELIBERATELY_UNPOLICIED.has(t),
    );

    expect(
      unexpected,
      `These tenant-scoped tables have no RLS policy in scripts/apply-rls.js. ` +
        `Add them to tenantScopedTables (or hybridGlobalTenantTables if tenant_id is nullable).`
    ).toEqual([]);
  });

  it.each([...DELIBERATELY_UNPOLICIED])('keeps %s OUT of apply-rls.js', (table) => {
    // The reverse of the check above, and the more important direction. Adding
    // the obvious policy here would not tighten anything — it would make every
    // row invisible forever and quietly destroy the erasure record.
    expect(registeredTables().has(table)).toBe(false);
  });

  it('keeps the known-gap list honest as tables get fixed', () => {
    // Guards the other direction: once a table IS registered, it must be dropped
    // from KNOWN_UNREGISTERED, so the list never overstates the debt.
    const registered = registeredTables();
    const staleEntries = [...KNOWN_UNREGISTERED].filter((t) => registered.has(t));

    expect(
      staleEntries,
      'These tables are now registered — remove them from KNOWN_UNREGISTERED.'
    ).toEqual([]);
  });
});
