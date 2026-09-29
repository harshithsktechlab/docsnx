/**
 * The write-side half of the business "Belongs to" picker.
 *
 * A company record may be filed under one of THAT company's members — the list
 * its picker offers. `assertHolderInTenant` alone would accept a household
 * member's id, so `isWorkspaceMember` narrows it: the tenant admins (who reach
 * every company without a grant) plus whoever holds a `company_access` row.
 *
 * The predicate itself is shared with /api/members, whose shape is asserted in
 * tests/memberWorkspaceScope.test.ts; these pin what the write check adds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: { grants: { userId: string }[]; users: any[]; wheres: any[] } = {
  grants: [], users: [], wheres: [],
};

function tableName(t: any): string {
  const key = t && Object.getOwnPropertySymbols(t).find((sy) => sy.description === 'drizzle:Name');
  return (key && t[key]) || '';
}

/** Bound values a drizzle `where` carries. */
function valuesOf(node: any, depth = 0, out: any[] = []): any[] {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if ('value' in node && typeof node.value !== 'object') out.push(node.value);
  if (Array.isArray(node.value)) out.push(...node.value);
  for (const chunk of node.queryChunks ?? []) valuesOf(chunk, depth + 1, out);
  if (Array.isArray(node)) for (const c of node) valuesOf(c, depth + 1, out);
  return out;
}

const fakeTx = {
  select: () => ({
    from: (table: any) => {
      const name = tableName(table);
      const chain: any = {
        where: (w: any) => {
          state.wheres.push({ table: name, values: valuesOf(w) });
          return chain;
        },
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: any) => resolve(name === 'company_access' ? state.grants : state.users),
      };
      return chain;
    },
  }),
};

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: (_tenantId: string, cb: any) => cb(fakeTx),
}));

const { isWorkspaceMember } = await import('@/lib/records/workspaceMembers');

const TENANT = 't-1';
const COMPANY = 'c-acme';
const DIRECTOR = 'u-director';

beforeEach(() => {
  state.grants = [];
  state.users = [];
  state.wheres = [];
});

describe('isWorkspaceMember — may this id hold a company record?', () => {
  it('asks the company\'s grants, then looks the holder up among admins + grantees', async () => {
    state.grants = [{ userId: DIRECTOR }];
    state.users = [{ id: DIRECTOR }];

    expect(await isWorkspaceMember(TENANT, DIRECTOR, COMPANY)).toBe(true);

    const [grants, lookup] = state.wheres;
    expect(grants.table).toBe('company_access');
    expect(grants.values).toContain(COMPANY);
    expect(lookup.table).toBe('users');
    // Tenant, the holder, the admin escape hatch, and the granted ids.
    expect(lookup.values).toEqual(expect.arrayContaining([TENANT, DIRECTOR, 'TENANT_ADMIN']));
  });

  it('refuses when the lookup finds nobody — a household member, or another company\'s', async () => {
    state.grants = [{ userId: 'u-someone-else' }];
    state.users = [];
    expect(await isWorkspaceMember(TENANT, 'u-household', COMPANY)).toBe(false);
  });

  it('with no grants at all, only an admin can qualify', async () => {
    state.grants = [];
    await isWorkspaceMember(TENANT, DIRECTOR, COMPANY);
    const lookup = state.wheres.find((w) => w.table === 'users');
    expect(lookup.values).toContain('TENANT_ADMIN');
    expect(lookup.values).not.toContain('personal');
  });

  it('the household is its own workspace: personal members and admins, no grant lookup', async () => {
    state.users = [{ id: 'u-household' }];
    expect(await isWorkspaceMember(TENANT, 'u-household', null)).toBe(true);
    expect(state.wheres.map((w) => w.table)).toEqual(['users']);
    expect(state.wheres[0].values).toEqual(expect.arrayContaining(['personal', 'TENANT_ADMIN']));
  });
});
