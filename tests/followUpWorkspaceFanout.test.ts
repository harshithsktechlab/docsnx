/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE RENEWAL PASS WALKS EVERY WORKSPACE, NOT JUST THE HOUSEHOLD         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `collectFollowUps` answers for ONE workspace — `companyId` null is the
 * household — and `notifyFollowUpsForUser` called it exactly once, with the
 * default. So for the whole life of the business account a company's renewals
 * were collected by nothing: a licence lapsing, a GST registration expiring, an
 * insurance policy running out inside a company were all dropped before any
 * notice was written.
 *
 * That failure is invisible from every direction. No error, no empty page — an
 * unnotified workspace looks exactly like one with nothing due, and the only
 * person who could tell the difference is the customer, three weeks later, whose
 * licence has expired. Hence a test rather than a careful reading.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER = {
  id: 'u1',
  tenantId: 't1',
  role: 'TENANT_ADMIN',
  tenant: { id: 't1', accountType: 'both' },
};

/** Rows handed to insert(), in call order. */
let inserted: any[] = [];
/** Every (user, companyId) pair `collectFollowUps` was asked for. */
let collectedFor: Array<string | null> = [];
/** What each workspace has due, keyed by company id ('' is the household). */
let itemsByWorkspace: Record<string, any[]> = {};
/** (title, body, link) of every push sent. */
let pushes: Array<[string, string, string]> = [];
let companies: Array<{ id: string; name: string }> = [];

const makeTx = () => ({
  insert: () => ({
    values: (rows: any[]) => {
      inserted.push(...rows);
      return {
        onConflictDoNothing: () => ({
          // Everything offered is accepted — the dedupe path itself is covered
          // by tests/followUpNotifications.test.ts.
          returning: () => Promise.resolve(rows.map((r, i) => ({
            id: `n${i}`,
            title: r.title,
            message: r.message,
            link: r.link,
            companyId: r.companyId,
          }))),
        }),
      };
    },
  }),
});

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: async (_t: string, cb: any) => cb(makeTx()),
}));

vi.mock('@/lib/push', () => ({
  sendPushNotification: async (_u: string, title: string, body: string, link: string) => {
    pushes.push([title, body, link]);
  },
}));

vi.mock('@/lib/auth', () => ({
  accessibleCompanies: async () => companies,
}));

vi.mock('@/lib/records/followUps', () => ({
  collectFollowUps: async (_user: any, companyId: string | null = null) => {
    collectedFor.push(companyId);
    return itemsByWorkspace[companyId ?? ''] ?? [];
  },
}));

vi.mock('@/lib/records/followUpCopy', () => ({
  followUpNoticeCopy: (item: any) => ({ title: item.title, message: `${item.title} is due` }),
}));

const { notifyFollowUpsForUser, dedupeKeyFor } = await import('@/lib/followUpNotifications');

/** A reminder inside its window, so it always produces a stage. */
const due = (id: string, title: string, link: string) => ({
  id, title, link, daysLeft: 2, alertWindowDays: 30,
});

beforeEach(() => {
  inserted = [];
  collectedFor = [];
  pushes = [];
  itemsByWorkspace = {};
  companies = [];
});

describe('every workspace the member can reach', () => {
  it('collects the household AND each company', async () => {
    companies = [{ id: 'c1', name: 'Acme' }, { id: 'c2', name: 'Beta' }];

    await notifyFollowUpsForUser(USER as any);

    // The household first and unconditionally: `workspaceMenu().hasPersonal`
    // looks like the test for "has a household" and is not — it is false for the
    // ordinary personal-only tenant, and reading it here would have silently
    // stopped the reminders that already worked.
    expect(collectedFor).toEqual([null, 'c1', 'c2']);
  });

  it('files each notice in the workspace it was found in', async () => {
    companies = [{ id: 'c1', name: 'Acme' }];
    itemsByWorkspace[''] = [due('insurance-expiry-p1', 'Car insurance', '/modules/insurance/vehicle')];
    itemsByWorkspace.c1 = [due('biz_licence-expiry-b1', 'Trade licence', '/business/c1/modules/biz_licence/trade')];

    await notifyFollowUpsForUser(USER as any);

    expect(inserted.map((r) => [r.companyId, r.accountScope, r.link])).toEqual([
      [null, 'personal', '/modules/insurance/vehicle'],
      ['c1', 'business', '/business/c1/modules/biz_licence/trade'],
    ]);
  });

  it('cannot collide two workspaces onto one dedupe key', async () => {
    // The record uuid is part of `FollowUpItem.id`, so the same field on the
    // same module in two companies is still two keys. If this ever stopped being
    // true, one workspace's reminder would suppress the other's — silently, and
    // only for tenants holding more than one workspace.
    const a = dedupeKeyFor({ id: 'biz_licence-expiry-aaaa' }, 'T-3');
    const b = dedupeKeyFor({ id: 'biz_licence-expiry-bbbb' }, 'T-3');
    expect(a).not.toEqual(b);
  });
});

describe('what the push says', () => {
  it('names the workspace when the account has more than one', async () => {
    companies = [{ id: 'c1', name: 'Acme' }];
    itemsByWorkspace[''] = [due('p1', 'Car insurance', '/modules/insurance/vehicle')];
    itemsByWorkspace.c1 = [due('b1', 'Trade licence', '/business/c1/modules/biz_licence/trade')];

    await notifyFollowUpsForUser(USER as any);

    // A push lands on a locked phone, where there is no chip and no shell to
    // read the workspace off. The bell row keeps the bare title — the panel is
    // already scoped to one workspace and would be repeating itself.
    expect(pushes.map((p) => p[0])).toEqual(['Personal · Car insurance', 'Acme · Trade licence']);
    expect(inserted.map((r) => r.title)).toEqual(['Car insurance', 'Trade licence']);
  });

  it('says nothing about the workspace on a household-only account', async () => {
    const household = { ...USER, tenant: { id: 't1', accountType: 'personal' } };
    itemsByWorkspace[''] = [due('p1', 'Car insurance', '/modules/insurance/vehicle')];

    await notifyFollowUpsForUser(household as any);

    // There is one workspace. Naming it is noise on every message this tenant
    // will ever receive, which is why the rule is "would the app draw a chip"
    // rather than "does the account have two halves".
    expect(pushes.map((p) => p[0])).toEqual(['Car insurance']);
  });

  it('deep-links a company notice into that company workspace', async () => {
    companies = [{ id: 'c1', name: 'Acme' }];
    itemsByWorkspace.c1 = [due('b1', 'Trade licence', '/business/c1/modules/biz_licence/trade')];

    await notifyFollowUpsForUser(USER as any);

    // What makes a tapped push land somewhere useful: the shell reads the open
    // workspace out of the path, so this URL both opens the record and switches
    // the chrome to the company it belongs to.
    expect(pushes[0][2]).toBe('/business/c1/modules/biz_licence/trade');
  });
});

describe('a dry run', () => {
  it('writes nothing, sends nothing, and says which workspace each notice is from', async () => {
    companies = [{ id: 'c1', name: 'Acme' }];
    itemsByWorkspace[''] = [due('p1', 'Car insurance', '/x')];
    itemsByWorkspace.c1 = [due('b1', 'Trade licence', '/business/c1/y')];

    const result = await notifyFollowUpsForUser(USER as any, { dryRun: true });

    expect(inserted).toEqual([]);
    expect(pushes).toEqual([]);
    expect(result.considered).toBe(2);
    expect(result.created).toBe(0);
    // A flat list of titles cannot be checked against the records it came from
    // when four workspaces report at once.
    expect(result.preview.map((n) => n.workspace)).toEqual(['Personal', 'Acme']);
  });
});
