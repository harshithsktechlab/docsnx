/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PASSWORDS, TO-DOS AND IMPORTANT CONTACTS BELONG TO ONE ACCOUNT         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * These three exist in BOTH accounts — a company has its own credentials, tasks
 * and contacts, and so does the household. The permission no longer separates
 * them (a business member legitimately holds `passwords`); the `company_id`
 * predicate and the vault's company do, and nothing else does.
 *
 * That is worth stating plainly, because it changes what a missing predicate
 * costs. There is no RLS behind this axis: both rows carry the same
 * `tenant_id`, so a query that forgets `company_id` returns the OTHER account's
 * rows and returns them successfully. The failure is a disclosure that renders
 * as a working page.
 *
 * So each layer is asserted separately, and each by breaking it:
 *   1. the SQL predicate           — `IS NULL` vs a bound company, per table
 *   2. the vault context           — the company reaches the seal, or the
 *                                    credential is written to the wrong store
 *   3. the request the page sends  — every call site carries the workspace
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('@/lib/db', () => ({ db: {}, withTenant: vi.fn() }));

const { todos, emergencyContacts, passwords } = await import('@/db/schema');
const { inCompanyOf, accountScopeFor } = await import('@/lib/records/companyScope');
const { withCompany } = await import('@/lib/net/useWorkspaceApi');

const dialect = new PgDialect();
const sqlFor = (query: any) => dialect.sqlToQuery(query);

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACME = '22222222-2222-4222-8222-222222222222';

/** The three tables the utilities live in, with the column that divides them. */
const TABLES = [
  { name: 'todos', table: todos, column: todos.companyId },
  { name: 'emergency_contacts', table: emergencyContacts, column: emergencyContacts.companyId },
  { name: 'passwords', table: passwords, column: passwords.companyId },
];

describe('the company predicate, per table', () => {
  for (const { name, table, column } of TABLES) {
    it(`${name}: personal compiles to IS NULL, never = NULL`, () => {
      const q = sqlFor(and(eq(table.tenantId, TENANT), inCompanyOf(column, null))!);

      // `= NULL` is NULL in SQL and matches nothing, so this mistake does not
      // leak — it empties the household's list, which reads to the user as
      // "my data is gone". Both directions are wrong; assert the shape.
      expect(q.sql).toMatch(/"company_id"\s+is\s+null/i);
      expect(q.sql).not.toMatch(/"company_id"\s*=/);
      expect(q.params).toEqual([TENANT]);
    });

    it(`${name}: a company compiles to a BOUND parameter`, () => {
      const q = sqlFor(and(eq(table.tenantId, TENANT), inCompanyOf(column, ACME))!);
      expect(q.sql).toMatch(/"company_id"\s*=\s*\$\d/);
      // Bound, not interpolated — the id arrives from a URL.
      expect(q.sql).not.toContain(ACME);
      expect(q.params).toEqual([TENANT, ACME]);
    });

    it(`${name}: the tenant predicate is never replaced by the company one`, () => {
      // The company axis sits INSIDE a tenant. A query scoped only by company
      // would cross tenants on a guessed id, which is the boundary that does
      // have RLS behind it — but the explicit predicate is the first line.
      const q = sqlFor(and(eq(table.tenantId, TENANT), inCompanyOf(column, ACME))!);
      expect(q.sql).toMatch(/"tenant_id"\s*=\s*\$\d/);
    });
  }

  it('undefined is treated as personal, not as "any company"', () => {
    // `companyIdFromRequest` returns null for absent and undefined for
    // malformed; the malformed case is rejected before it reaches here, but a
    // predicate that widened on undefined would be the worst possible default.
    const q = sqlFor(inCompanyOf(todos.companyId, undefined));
    expect(q.sql).toMatch(/is\s+null/i);
  });

  it('accountScopeFor mirrors the column the CHECK constraint pins', () => {
    expect(accountScopeFor(null)).toBe('personal');
    expect(accountScopeFor(undefined)).toBe('personal');
    expect(accountScopeFor(ACME)).toBe('business');
  });
});

describe('the vault seals a credential into its own account', () => {
  beforeEach(() => vi.resetModules());

  /** Captures the ctx `storePasswordInVault` hands the store layer. */
  async function ctxFrom(companyId: string | null) {
    const seen: any[] = [];
    vi.doMock('@/lib/vault/vaultRecords', () => ({
      upsertRecord: vi.fn(async (ctx: any) => {
        seen.push(ctx);
        return { jsonDriveId: 'drive-1' };
      }),
      readJsonStore: vi.fn(),
      softDeleteRecord: vi.fn(),
    }));
    vi.doMock('@/lib/fieldCrypto', () => ({
      encryptField: (v: string) => `enc:${v}`,
      decryptField: (v: string) => v,
    }));

    const { storePasswordInVault } = await import('@/lib/vault/vaultPasswords');
    await storePasswordInVault({
      tenant: { id: TENANT } as any,
      tenantId: TENANT,
      companyId,
      actorUserId: 'u1',
      ownerId: 'u1',
      recordId: 'p1',
      category: 'Banking',
      title: 'Acme bank',
      password: 's3cret',
    });
    expect(seen).toHaveLength(1);
    return seen[0];
  }

  it("carries the company into the store context, which picks the folder AND the AAD", async () => {
    expect((await ctxFrom(ACME)).companyId).toBe(ACME);
  });

  it('carries null for the household, unchanged from before companies existed', async () => {
    expect((await ctxFrom(null)).companyId).toBeNull();
  });

  it('never lets the tenant stand in for the company', async () => {
    // The defect this guards against is silent: a ctx missing the company seals
    // an Acme credential into the PERSONAL store under the personal AAD. No
    // error is raised — the password is simply absent when Acme looks for it,
    // and present in the household's vault, where it must never be.
    const ctx = await ctxFrom(ACME);
    expect(ctx.companyId).not.toBe(ctx.tenantId);
    expect(ctx.companyId).not.toBeUndefined();
  });
});

describe('and unseals it from the same account it was sealed into', () => {
  /**
   * The READ half, which the block above does not cover — and which was wrong.
   *
   * `GET /api/passwords/:id` built its vault ctx with no company, so the store
   * it opened was the PERSONAL one for every credential, including a company's.
   * The record is not in that file, so `revealPassword` returned null and the
   * route answered `success: true` with `password: null`: the eye on the card
   * showed "— none stored —", Copy copied nothing, and the Edit form opened
   * empty. A write that lands correctly and a read that cannot find it is the
   * same bug as writing it to the wrong place, seen from the other end.
   */
  beforeEach(() => vi.resetModules());

  /** Captures the ctx `revealPassword` hands the store layer. */
  async function revealCtxFrom(companyId: string | null) {
    const seen: any[] = [];
    vi.doMock('@/lib/vault/vaultRecords', () => ({
      readJsonStore: vi.fn(async (ctx: any) => {
        seen.push(ctx);
        return { store: { records: {} }, pointer: null };
      }),
      upsertRecord: vi.fn(),
      softDeleteRecord: vi.fn(),
    }));
    vi.doMock('@/lib/fieldCrypto', () => ({
      encryptField: (v: string) => `enc:${v}`,
      decryptField: (v: string) => v,
    }));

    const { revealPassword } = await import('@/lib/vault/vaultPasswords');
    await revealPassword(
      { tenant: { id: TENANT } as any, tenantId: TENANT, companyId, userId: 'u1' },
      { moduleKey: 'passwords', documentKey: 'banking' } as any,
      'p1',
    );
    expect(seen).toHaveLength(1);
    return seen[0];
  }

  it('opens the company store when the credential is a company one', async () => {
    expect((await revealCtxFrom(ACME)).companyId).toBe(ACME);
  });

  it('opens the personal store for the household, exactly as before', async () => {
    expect((await revealCtxFrom(null)).companyId).toBeNull();
  });

  it('never treats a missing company as the personal account', async () => {
    // `undefined` is the shape of the bug: it is not rejected anywhere, it just
    // MEANS personal. So the reveal path takes a ctx whose company is written
    // out — a value of null is a decision, an absent key is an oversight.
    const ctx = await revealCtxFrom(ACME);
    expect(ctx.companyId).not.toBeUndefined();
    expect(ctx.companyId).not.toBe(ctx.tenantId);
  });
});

describe('the page sends its workspace with every request', () => {
  it('appends the company, preserving an existing query', () => {
    expect(withCompany('/api/todos', ACME)).toBe(`/api/todos?companyId=${ACME}`);
    expect(withCompany('/api/todos?status=PENDING', ACME))
      .toBe(`/api/todos?status=PENDING&companyId=${ACME}`);
  });

  it('leaves the personal request byte-identical', () => {
    // The rollback contract in miniature: with no company the URL is exactly
    // what the pre-business build sent, so the old routes still answer it.
    for (const url of ['/api/passwords', '/api/todos/count', '/api/important-contacts/abc']) {
      expect(withCompany(url, null)).toBe(url);
    }
  });

  it('encodes the id rather than pasting it into the query', () => {
    expect(withCompany('/api/todos', 'a&b=c' as any)).toBe('/api/todos?companyId=a%26b%3Dc');
  });
});

describe('no call site was missed', () => {
  // The mechanical half of the review, kept as a test because the manual half
  // does not survive the next edit to these pages. A bare `apiCall(` here means
  // a request that goes out WITHOUT the workspace: in a company it reads or
  // writes the household's rows, renders perfectly, and reports nothing.
  const PAGES = [
    'src/app/passwords/page.js',
    'src/app/todos/page.js',
    'src/app/important-contacts/page.js',
  ];

  /** The one deliberate exception: the member list is tenant-wide. */
  const ALLOWED = new Set(["await apiCall('/api/users')"]);

  it('routes every request on the three pages through the workspace-bound api', async () => {
    const { readFileSync } = await import('node:fs');
    for (const page of PAGES) {
      const src = readFileSync(page, 'utf8');
      const stray = [...src.matchAll(/await apiCall\([^)]*\)/g)]
        .map((m) => m[0])
        .filter((call) => !ALLOWED.has(call));
      expect(stray, `${page} calls the API without its workspace`).toEqual([]);
      expect(src, page).toContain('useWorkspaceApi');
    }
  });

  /**
   * The server-side counterpart, and the check that would have caught the
   * reveal bug: the page carried its workspace all the way to the handler, and
   * the handler then dropped it on the floor when it built the vault context.
   *
   * A ctx literal is recognisable by `tenant: user.tenant` — it is the only
   * thing constructed that way — and every one of them must name the company,
   * because the type permits leaving it out and the cost of leaving it out is
   * a store read against the wrong account.
   */
  const VAULT_CTX_ROUTES = [
    'src/app/api/passwords/route.ts',
    'src/app/api/passwords/[id]/route.ts',
  ];

  /**
   * One vault-context literal, from `tenant: user.tenant` to the brace that
   * closes the object around it — found by balancing braces rather than by
   * reading ahead a fixed number of characters. The first draft did the latter
   * and two of the three literals ran past the budget, so they matched nothing
   * and were silently not checked at all; that is the failure mode this whole
   * block exists to prevent, reproduced inside the test itself.
   */
  function ctxLiteralAt(src: string, from: number): string {
    let depth = 1;
    for (let i = from; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(from, i + 1);
      }
    }
    return src.slice(from);
  }

  it('names the company in every vault context the password routes build', async () => {
    const { readFileSync } = await import('node:fs');
    for (const route of VAULT_CTX_ROUTES) {
      // Comments out first: a `companyId` mentioned in prose beside a context
      // that does not set one would otherwise satisfy this.
      const src = readFileSync(route, 'utf8').replace(/^\s*\/\/.*$/gm, '');

      const literals = [...src.matchAll(/tenant: user\.tenant/g)]
        .map((m) => ctxLiteralAt(src, m.index!));
      expect(literals.length, `${route} builds no vault context`).toBeGreaterThan(0);

      for (const literal of literals) {
        expect(literal, `${route} builds a vault context with no companyId`).toContain('companyId');
      }
    }
  });
});
