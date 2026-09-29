/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   TWO SUBSCRIPTIONS, TWO LADDERS                                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Since 0057 a tenant holds a personal plan and a business plan on their own
 * dates. The expiry ladder read `subscription_expiry` alone — which since that
 * migration means the HOUSEHOLD's — so a lapsing business plan warned nobody on
 * any of the three channels, and the company workspace locked at T-0 out of a
 * clear sky.
 *
 * What these pin is the part that cannot be seen by reading the cron: which
 * column each ladder counts down, which column it remembers itself in, who is
 * told, and whether the message says which half of the account it is about.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let tenant: any;
let members: any[];
let plan: any;

/** Rows written to `notifications`, in order. */
let inserted: any[] = [];
/** What the tenant UPDATE set. */
let tenantUpdates: any[] = [];
let pushes: Array<{ userId: string; title: string; link: string }> = [];
let emails: Array<{ email: string; half: string | null; billingUrl: string }> = [];

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      tenants: { findFirst: async () => tenant },
      subscriptionPlans: { findFirst: async () => plan },
      users: { findMany: async () => members },
    },
    update: () => ({
      set: (values: any) => ({ where: async () => { tenantUpdates.push(values); } }),
    }),
  },
  withTenant: async (_t: string, cb: any) => cb({
    insert: () => ({ values: async (row: any) => { inserted.push(row); } }),
  }),
}));

vi.mock('@/lib/push', () => ({
  sendPushNotification: async (userId: string, title: string, _b: string, link: string) => {
    pushes.push({ userId, title, link });
  },
}));

vi.mock('@/lib/mailer', () => ({
  sendPlanExpiryEmail: async (opts: any) => {
    emails.push({ email: opts.email, half: opts.half ?? null, billingUrl: opts.billingUrl });
    return { success: true };
  },
}));

vi.mock('@/lib/appUrl', () => ({ getAppBaseUrl: () => 'https://app.example' }));

const { notifyPlanExpiry, runPlanExpiryCheck } = await import('@/lib/planNotifications');

const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

beforeEach(() => {
  inserted = [];
  tenantUpdates = [];
  pushes = [];
  emails = [];
  plan = { id: 'p1', name: 'Gold Annual' };
  tenant = {
    id: 't1',
    name: 'Sharma Household',
    accountType: 'both',
    subscriptionPlanId: 'p1',
    subscriptionExpiry: inDays(30),
    businessPlanId: 'p1',
    businessPlanExpiry: inDays(3),
    planNoticeStage: null,
    businessPlanNoticeStage: null,
  };
  members = [
    { id: 'admin', name: 'Asha', email: 'asha@example.com', role: 'TENANT_ADMIN', accountScope: 'personal' },
    { id: 'home', name: 'Ravi', email: 'ravi@example.com', role: 'STANDARD', accountScope: 'personal' },
    { id: 'work', name: 'Neha', email: 'neha@example.com', role: 'STANDARD', accountScope: 'business' },
    { id: 'ops', name: 'Ops', email: 'ops@example.com', role: 'SUPER_ADMIN', accountScope: 'personal' },
  ];
});

describe('which axis a ladder counts down', () => {
  it('runs the business ladder off the BUSINESS expiry', async () => {
    // The household plan has 30 days left and the business one 3. Reading
    // `subscription_expiry` for a business notice — which is what this file did
    // — announces nothing at all, because 30 days is not a milestone.
    const result = await runPlanExpiryCheck(tenant, 'business');

    expect(result?.stage).toBe('T-3');
    expect(result?.axis).toBe('business');
  });

  it('says nothing on the personal axis while the household plan is healthy', async () => {
    expect(await runPlanExpiryCheck(tenant, 'personal')).toBeNull();
  });

  it('remembers each ladder in its OWN column', async () => {
    await notifyPlanExpiry('t1', 'business', 'T-3');

    // Stages only ever move forward within a term, so one shared column would
    // mean a household plan sitting at 'EXPIRED' swallowed every business notice
    // behind it.
    expect(tenantUpdates[0]).toMatchObject({ businessPlanNoticeStage: 'T-3' });
    expect(tenantUpdates[0].planNoticeStage).toBeUndefined();
  });

  it('does not re-send a stage the business column has already recorded', async () => {
    tenant.businessPlanNoticeStage = 'T-1';
    // T-1 is past T-3, so nothing is due — and the personal column must not be
    // the one consulted for that decision.
    expect(await runPlanExpiryCheck(tenant, 'business')).toBeNull();
  });
});

describe('who is told', () => {
  it('tells the admin and the members of THAT half, and nobody else', async () => {
    const result = await notifyPlanExpiry('t1', 'business', 'T-3');

    // A member hired to work on a company has no household records, cannot pay
    // for one, and the notice names a plan they have no way to see.
    expect(inserted.map((r) => r.userId).sort()).toEqual(['admin', 'work']);
    expect(result.recipients).toBe(2);
  });

  it('tells the household side about the household plan', async () => {
    tenant.subscriptionExpiry = inDays(3);
    await notifyPlanExpiry('t1', 'personal', 'T-3');

    expect(inserted.map((r) => r.userId).sort()).toEqual(['admin', 'home']);
  });

  it('never tells a platform operator', async () => {
    await notifyPlanExpiry('t1', 'business', 'T-3');
    expect(inserted.map((r) => r.userId)).not.toContain('ops');
  });

  it('tells everyone on a tenant with a single half, whatever their scope says', async () => {
    tenant.accountType = 'personal';
    tenant.subscriptionExpiry = inDays(3);

    await notifyPlanExpiry('t1', 'personal', 'T-3');

    // One plan, and it locks everything they have. A member carrying a stale
    // `account_scope` must not be the one person never told why the app is dark.
    expect(inserted.map((r) => r.userId).sort()).toEqual(['admin', 'home', 'work']);
  });
});

describe('what the notice says', () => {
  it('names the half on an account that has two', async () => {
    await notifyPlanExpiry('t1', 'business', 'T-3');

    expect(inserted[0].title).toBe('Business plan expires in 3 days');
    // The half is in the TITLE because that is the line a push and a lock screen
    // show; a body is truncated first.
    expect(pushes[0].title).toBe('Business plan expires in 3 days');
    expect(emails[0].half).toBe('Business');
  });

  it('leaves the wording exactly as it was on a single-half account', async () => {
    tenant.accountType = 'personal';
    tenant.subscriptionExpiry = inDays(3);

    await notifyPlanExpiry('t1', 'personal', 'T-3');

    // "Your Personal plan" is noise to a household that has only one.
    expect(inserted[0].title).toBe('Plan expires in 3 days');
    expect(inserted[0].message).toContain('Renew it to avoid the workspace locking.');
    expect(emails[0].half).toBeNull();
  });

  it('opens the billing tab it is actually about', async () => {
    await notifyPlanExpiry('t1', 'business', 'T-3');

    const admin = inserted.find((r) => r.userId === 'admin');
    expect(admin.link).toBe('/billing?axis=business');
    expect(emails.find((e) => e.email === 'asha@example.com')?.billingUrl)
      .toBe('https://app.example/billing?axis=business');
  });

  it('sends a member to the locked screen, not to a billing page they cannot use', async () => {
    const member = inserted.find((r) => r.userId === 'work');
    expect(member).toBeUndefined();

    await notifyPlanExpiry('t1', 'business', 'T-3');
    expect(inserted.find((r) => r.userId === 'work').link).toBe('/billing/expired');
  });
});

describe('where a plan notice is filed', () => {
  it('is account-level, so it is reachable from every workspace', async () => {
    await notifyPlanExpiry('t1', 'business', 'T-3');

    // The bell is scoped to the workspace you are standing in, and this is the
    // one message that explains why a workspace locked. Filing it as 'business'
    // would hide it from the admin working in Personal — the only person able to
    // pay it.
    expect(inserted[0].accountScope).toBe('account');
    expect(inserted[0].companyId).toBeNull();
  });
});
