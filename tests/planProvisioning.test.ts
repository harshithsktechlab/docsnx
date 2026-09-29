import { describe, it, expect, vi } from 'vitest';
import {
  planExpiry,
  newTenantPlanValues,
  creditBalanceDelta,
  adjustTenantCredits,
  setTenantCredits,
  applyPlanToTenant,
  recordCreditMovement,
  recordSignupGrant,
  type SubscriptionPlan,
} from '@/lib/planProvisioning';
import { creditTransactions } from '@/db/schema';
import { CREDIT_REASONS } from '@/lib/creditLedger';

const DAY = 24 * 60 * 60 * 1000;

/** Minimal plan row — only the fields the provisioning helpers read. */
function makePlan(overrides: Partial<SubscriptionPlan> = {}): SubscriptionPlan {
  return {
    id: '0dd5fb0a-4b68-4a5e-95ea-df598d7d924c',
    name: 'Trial',
    aiCredits: 100,
    durationDays: 60,
    isLifetime: false,
    ...overrides,
  } as SubscriptionPlan;
}

/**
 * Records what was written so the assertions can inspect the update and both
 * inserts.
 *
 * The two inserts are told apart by table identity rather than by call order:
 * every credit helper writes an audit row AND a ledger row, and a positional
 * fake would silently let one overwrite the other — which is exactly the bug
 * these tests exist to catch.
 *
 * `priorBalance` is what the tenant row reads as BEFORE the update, which the
 * helpers use to record the movement that actually happened (the GREATEST floor
 * means the requested delta and the real one can differ). `returnedBalance` is
 * what the UPDATE ... RETURNING yields.
 */
function makeFakeTx(returnedBalance = 0, priorBalance = 0, accountType: string | null = 'personal') {
  const calls: {
    set?: Record<string, unknown>;
    audit?: Record<string, unknown>;
    ledger?: Record<string, unknown>;
  } = {};

  return {
    calls,
    query: {
      tenants: {
        findFirst: async () => ({ aiCreditsBalance: priorBalance, accountType }),
      },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        calls.set = values;
        return {
          where: () => ({
            returning: async () => [{ aiCreditsBalance: returnedBalance }],
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
          }),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (table === creditTransactions) calls.ledger = values;
        else calls.audit = values;
      },
    }),
  } as any;
}

describe('planExpiry', () => {
  it('adds the plan duration to today for a fresh subscription', () => {
    const expiry = planExpiry(makePlan({ durationDays: 60 }));
    expect(expiry).toBeInstanceOf(Date);
    const days = Math.round((expiry!.getTime() - Date.now()) / DAY);
    expect(days).toBe(60);
  });

  it('extends an unexpired term instead of truncating it', () => {
    const remaining = new Date(Date.now() + 30 * DAY);
    const expiry = planExpiry(makePlan({ durationDays: 60 }), remaining);
    const days = Math.round((expiry!.getTime() - Date.now()) / DAY);
    expect(days).toBe(90);
  });

  it('starts from today when the existing term has already lapsed', () => {
    const lapsed = new Date(Date.now() - 30 * DAY);
    const expiry = planExpiry(makePlan({ durationDays: 60 }), lapsed);
    const days = Math.round((expiry!.getTime() - Date.now()) / DAY);
    expect(days).toBe(60);
  });

  it('never expires for lifetime or duration-less plans', () => {
    expect(planExpiry(makePlan({ isLifetime: true }))).toBeNull();
    expect(planExpiry(makePlan({ durationDays: null }))).toBeNull();
    expect(planExpiry(makePlan({ durationDays: 0 }))).toBeNull();
  });
});

describe('newTenantPlanValues', () => {
  it('seeds the AI credit balance from the plan — the bug this fixes', () => {
    const values = newTenantPlanValues(makePlan({ aiCredits: 100 }));
    expect(values.aiCreditsBalance).toBe(100);
    expect(values.subscriptionPlanId).toBe('0dd5fb0a-4b68-4a5e-95ea-df598d7d924c');
    expect(Math.round((values.subscriptionExpiry!.getTime() - Date.now()) / DAY)).toBe(60);
  });

  it('provisions no plan and no credits when there is no plan', () => {
    expect(newTenantPlanValues(null)).toEqual({
      subscriptionPlanId: null,
      subscriptionExpiry: null,
      aiCreditsBalance: 0,
    });
  });

  it('treats a plan with no credits as zero rather than undefined', () => {
    expect(newTenantPlanValues(makePlan({ aiCredits: 0 })).aiCreditsBalance).toBe(0);
  });
});

describe('creditBalanceDelta', () => {
  /** Concatenates the literal SQL text of a drizzle fragment, ignoring bound params. */
  const sqlText = (fragment: any): string =>
    (fragment.queryChunks || [])
      .flatMap((chunk: any) => (Array.isArray(chunk?.value) ? chunk.value : []))
      .join('');

  it('builds an in-database addition floored at zero', () => {
    const text = sqlText(creditBalanceDelta(100));
    expect(text).toContain('GREATEST');
    expect(text).toContain('+');
    // The column is referenced, so the sum happens in Postgres rather than in JS.
    expect(text).not.toContain('100');
  });

  it('truncates fractional amounts to whole credits', () => {
    const numbers = (creditBalanceDelta(2.7) as any).queryChunks.filter((c: any) => typeof c === 'number');
    expect(numbers).toContain(2);
  });
});

describe('adjustTenantCredits', () => {
  it('writes the delta and an audit row, and returns the new balance', async () => {
    const tx = makeFakeTx(150);

    const balance = await adjustTenantCredits(tx, {
      tenantId: 'tenant-1',
      amount: 50,
      userId: 'admin-1',
      action: 'ADMIN_CREDIT_ADJUST',
      details: 'Trial top-up',
    });

    expect(balance).toBe(150);
    expect(tx.calls.set).toHaveProperty('aiCreditsBalance');
    expect(tx.calls.audit).toMatchObject({
      tenantId: 'tenant-1',
      userId: 'admin-1',
      action: 'ADMIN_CREDIT_ADJUST',
    });
  });

  it('records a null user for system-initiated grants', async () => {
    const tx = makeFakeTx(100);
    await adjustTenantCredits(tx, {
      tenantId: 'tenant-1',
      amount: 100,
      action: 'ADDON_CREDITS_GRANTED_WEBHOOK',
      details: 'webhook grant',
    });
    expect(tx.calls.audit!.userId).toBeNull();
  });
});

describe('setTenantCredits', () => {
  it('writes the balance as a plain number, not a delta fragment', async () => {
    const tx = makeFakeTx(5000);

    const balance = await setTenantCredits(tx, {
      tenantId: 'tenant-1',
      balance: 5000,
      userId: 'admin-1',
      action: 'ADMIN_CREDIT_ADJUST',
      details: 'Corrected after migration',
    });

    expect(balance).toBe(5000);
    expect(tx.calls.set!.aiCreditsBalance).toBe(5000);
    expect(tx.calls.audit).toMatchObject({
      tenantId: 'tenant-1',
      userId: 'admin-1',
      action: 'ADMIN_CREDIT_ADJUST',
      details: 'Corrected after migration',
    });
  });

  it('clears the balance when set to zero', async () => {
    const tx = makeFakeTx(0);
    const balance = await setTenantCredits(tx, {
      tenantId: 'tenant-1', balance: 0, action: 'ADMIN_CREDIT_ADJUST', details: 'revoked',
    });
    expect(balance).toBe(0);
    expect(tx.calls.set!.aiCreditsBalance).toBe(0);
  });

  it('clamps a negative balance to zero rather than storing it', async () => {
    const tx = makeFakeTx(0);
    await setTenantCredits(tx, {
      tenantId: 'tenant-1', balance: -500, action: 'ADMIN_CREDIT_ADJUST', details: 'bad input',
    });
    expect(tx.calls.set!.aiCreditsBalance).toBe(0);
  });

  it('truncates a fractional balance to a whole credit', async () => {
    const tx = makeFakeTx(12);
    await setTenantCredits(tx, {
      tenantId: 'tenant-1', balance: 12.9, action: 'ADMIN_CREDIT_ADJUST', details: 'rounding',
    });
    expect(tx.calls.set!.aiCreditsBalance).toBe(12);
  });

  it('records a null user for system-initiated resets', async () => {
    const tx = makeFakeTx(0);
    await setTenantCredits(tx, {
      tenantId: 'tenant-1', balance: 0, action: 'SYSTEM_RESET', details: 'reset',
    });
    expect(tx.calls.audit!.userId).toBeNull();
  });
});

describe('applyPlanToTenant', () => {
  it('grants the plan credits alongside the plan and expiry', async () => {
    const tx = makeFakeTx();

    const result = await applyPlanToTenant(tx, {
      tenantId: 'tenant-1',
      plan: makePlan({ name: 'Pro Monthly', aiCredits: 50, durationDays: 30 }),
      userId: 'admin-1',
      action: 'tenant.manual_upgrade',
      reason: 'comped',
    });

    expect(result.creditsGranted).toBe(50);
    expect(tx.calls.set).toHaveProperty('aiCreditsBalance');
    expect(tx.calls.set!.subscriptionPlanId).toBe('0dd5fb0a-4b68-4a5e-95ea-df598d7d924c');
    // One grammar for the whole trail — see auditSentence in auditActions.ts.
    // The expiry is 30 days from now, so it is matched by shape, not by value.
    expect(tx.calls.audit!.details).toMatch(
      /^Granted plan "Pro Monthly" \u2014 50 AI credits, expires \d{4}-\d{2}-\d{2}, comped\.$/
    );
    expect(tx.calls.audit!.details).toContain('comped');
  });

  it('clears the expiry-notice stage so a renewal re-arms the reminders', async () => {
    const tx = makeFakeTx();

    await applyPlanToTenant(tx, {
      tenantId: 'tenant-1',
      plan: makePlan(),
      action: 'PAYMENT_CAPTURED_WEBHOOK',
    });

    // Left set, the daily job would treat the new term as already announced and
    // the tenant would next hear from us on the day it expired.
    expect(tx.calls.set!.planNoticeStage).toBeNull();
    expect(tx.calls.set!.planNoticeSentAt).toBeNull();
  });

  it('does not touch the balance for a plan that grants no credits', async () => {
    const tx = makeFakeTx();

    const result = await applyPlanToTenant(tx, {
      tenantId: 'tenant-1',
      plan: makePlan({ aiCredits: 0 }),
      action: 'PAYMENT_CAPTURED_WEBHOOK',
    });

    expect(result.creditsGranted).toBe(0);
    expect(tx.calls.set).not.toHaveProperty('aiCreditsBalance');
  });

  it('honours an explicit billing-cycle expiry over the plan duration', async () => {
    const tx = makeFakeTx();
    const yearly = new Date(Date.now() + 365 * DAY);

    const result = await applyPlanToTenant(tx, {
      tenantId: 'tenant-1',
      plan: makePlan({ durationDays: 30 }),
      expiry: yearly,
      action: 'PAYMENT_CAPTURED_WEBHOOK',
    });

    expect(result.expiry).toBe(yearly);
    expect(tx.calls.set!.subscriptionExpiry).toBe(yearly);
  });

  it('accepts a null expiry for a one-time purchase', async () => {
    const tx = makeFakeTx();
    const result = await applyPlanToTenant(tx, {
      tenantId: 'tenant-1',
      plan: makePlan(),
      expiry: null,
      action: 'PAYMENT_CAPTURED_WEBHOOK',
    });
    expect(result.expiry).toBeNull();
    expect(tx.calls.set!.subscriptionExpiry).toBeNull();
  });

  it('merges extra tenant columns into the same update', async () => {
    const tx = makeFakeTx();
    await applyPlanToTenant(tx, {
      tenantId: 'tenant-1',
      plan: makePlan(),
      action: 'PAYMENT_CAPTURED_WEBHOOK',
      extraTenantValues: { isActive: true },
    });
    expect(tx.calls.set!.isActive).toBe(true);
  });
});

// ─── The credit ledger ───────────────────────────────────────────────────────
//
// The ledger exists so a tenant can see WHY their balance is what it is, which
// only holds if every helper that moves the balance also writes a row, and if
// that row records the movement that actually happened rather than the one that
// was requested.

describe('recordCreditMovement', () => {
  it('writes one ledger row with the signed amount and the resulting balance', async () => {
    const tx = makeFakeTx();
    await recordCreditMovement(tx, {
      tenantId: 'tenant-1',
      userId: 'user-1',
      amount: -40,
      balanceAfter: 60,
      reason: CREDIT_REASONS.spend_bulk_scan,
      description: 'Power scan — 40 credits.',
    });

    expect(tx.calls.ledger).toMatchObject({
      tenantId: 'tenant-1',
      userId: 'user-1',
      amount: -40,
      balanceAfter: 60,
      reason: 'spend_bulk_scan',
    });
  });

  it('drops a zero movement rather than writing a "granted 0 credits" line', async () => {
    const tx = makeFakeTx();
    await recordCreditMovement(tx, {
      tenantId: 'tenant-1',
      amount: 0,
      balanceAfter: 100,
      reason: CREDIT_REASONS.plan_grant,
      description: 'Plan with no AI credits.',
    });

    expect(tx.calls.ledger).toBeUndefined();
  });

  it('records a null user for system, webhook and cron movements', async () => {
    const tx = makeFakeTx();
    await recordCreditMovement(tx, {
      tenantId: 'tenant-1',
      amount: 500,
      balanceAfter: 500,
      reason: CREDIT_REASONS.addon_grant,
      description: 'Add-ons purchased.',
    });

    expect(tx.calls.ledger!.userId).toBeNull();
  });

  it('never throws — a ledger failure must not roll back the payment above it', async () => {
    const exploding = {
      insert: () => ({ values: async () => { throw new Error('RLS denied'); } }),
    } as any;

    await expect(recordCreditMovement(exploding, {
      tenantId: 'tenant-1',
      amount: 10,
      balanceAfter: 10,
      reason: CREDIT_REASONS.plan_grant,
      description: 'x',
    })).resolves.toBeUndefined();
  });
});

describe('adjustTenantCredits — ledger row', () => {
  it('writes a ledger row alongside the audit row', async () => {
    const tx = makeFakeTx(150, 100);
    await adjustTenantCredits(tx, {
      tenantId: 'tenant-1',
      amount: 50,
      userId: 'admin-1',
      action: 'credits.admin_adjust',
      details: 'Super admin adjusted AI credits by +50.',
    });

    // Both rows, neither overwriting the other.
    expect(tx.calls.audit).toBeDefined();
    expect(tx.calls.ledger).toMatchObject({
      amount: 50,
      balanceAfter: 150,
      reason: 'admin_adjust',
      userId: 'admin-1',
    });
  });

  it('records the FLOORED movement, not the requested delta', async () => {
    // Balance 100, delta -1000: GREATEST floors the result at 0, so only 100
    // credits actually moved. Recording -1000 would make the ledger contradict
    // the balance it exists to explain.
    const tx = makeFakeTx(0, 100);
    await adjustTenantCredits(tx, {
      tenantId: 'tenant-1',
      amount: -1000,
      action: 'credits.admin_adjust',
      details: 'clearing balance',
    });

    expect(tx.calls.ledger!.amount).toBe(-100);
    expect(tx.calls.ledger!.balanceAfter).toBe(0);
  });

  it('prefers the tenant-facing ledgerDescription over the staff-facing details', async () => {
    const tx = makeFakeTx(150, 100);
    await adjustTenantCredits(tx, {
      tenantId: 'tenant-1',
      amount: 50,
      action: 'credits.admin_adjust',
      details: 'Super admin adjusted AI credits by +50. Previous balance: 100.',
      ledgerDescription: 'Credits adjusted by +50. Reason: goodwill',
    });

    expect(tx.calls.ledger!.description).toBe('Credits adjusted by +50. Reason: goodwill');
  });

  it('lets a caller override the reason for a non-admin grant', async () => {
    const tx = makeFakeTx(600, 100);
    await adjustTenantCredits(tx, {
      tenantId: 'tenant-1',
      amount: 500,
      action: 'credits.addon_granted_webhook',
      details: 'add-ons',
      reason: CREDIT_REASONS.addon_grant,
    });

    expect(tx.calls.ledger!.reason).toBe('addon_grant');
  });
});

describe('setTenantCredits — ledger row', () => {
  it('records the signed difference an absolute set produced', async () => {
    const tx = makeFakeTx(40, 100);
    await setTenantCredits(tx, {
      tenantId: 'tenant-1',
      balance: 40,
      action: 'credits.admin_adjust',
      details: 'corrected to 40',
    });

    expect(tx.calls.ledger).toMatchObject({
      amount: -60,
      balanceAfter: 40,
      reason: 'admin_set',
    });
  });
});

describe('applyPlanToTenant — ledger row', () => {
  it('records the granted credits and names the plan', async () => {
    const tx = makeFakeTx(600, 100);
    await applyPlanToTenant(tx, {
      tenantId: 'tenant-1',
      plan: makePlan({ name: 'Member Pro', aiCredits: 500 }),
      action: 'PAYMENT_CAPTURED_WEBHOOK',
    });

    expect(tx.calls.ledger).toMatchObject({
      amount: 500,
      balanceAfter: 600,
      reason: 'plan_grant',
    });
    expect(tx.calls.ledger!.description).toContain('Member Pro');
  });

  it('writes no ledger row for a plan that grants no credits', async () => {
    const tx = makeFakeTx(100, 100);
    await applyPlanToTenant(tx, {
      tenantId: 'tenant-1',
      plan: makePlan({ aiCredits: 0 }),
      action: 'PAYMENT_CAPTURED_WEBHOOK',
    });

    expect(tx.calls.ledger).toBeUndefined();
    // The audit row still lands — the plan change itself is worth recording.
    expect(tx.calls.audit).toBeDefined();
  });
});

describe('recordSignupGrant', () => {
  it('opens the ledger with balanceAfter equal to the seeded amount', async () => {
    const tx = makeFakeTx();
    await recordSignupGrant(tx, {
      tenantId: 'tenant-1',
      amount: 100,
      userId: 'user-1',
      planName: 'Trial',
    });

    expect(tx.calls.ledger).toMatchObject({
      amount: 100,
      balanceAfter: 100,
      reason: 'signup_grant',
    });
    expect(tx.calls.ledger!.description).toContain('Trial');
  });

  it('writes nothing for a tenant provisioned with no credits', async () => {
    const tx = makeFakeTx();
    await recordSignupGrant(tx, { tenantId: 'tenant-1', amount: 0 });
    expect(tx.calls.ledger).toBeUndefined();
  });
});

/**
 * ── A PLAN ON AN AXIS MEANS THE TENANT HAS THAT AXIS ──────────────────────
 * A personal tenant handed a combo plan is a Personal + Business account from
 * that update on. Leaving `account_type` at 'personal' would hide the half
 * just paid for: no billing tab, no workspace switcher, no company creation.
 * Never narrows — that is `/api/account/erase`.
 */
describe('applyPlanToTenant widens account_type', () => {
  const apply = (tx: any, appliesTo: string) => applyPlanToTenant(tx, {
    tenantId: 'tenant-1',
    plan: makePlan({ name: 'Combo', appliesTo } as any),
    action: 'payment.verify',
  });

  it('makes a personal tenant both when it is given a combo plan', async () => {
    const tx = makeFakeTx(0, 0, 'personal');
    await apply(tx, 'both');
    expect(tx.calls.set!.accountType).toBe('both');
    // Both column pairs, with one plan id.
    expect(tx.calls.set!.subscriptionPlanId).toBe(tx.calls.set!.businessPlanId);
  });

  it('makes a business tenant both when it is given a combo plan', async () => {
    const tx = makeFakeTx(0, 0, 'business');
    await apply(tx, 'both');
    expect(tx.calls.set!.accountType).toBe('both');
  });

  it('does not touch account_type when only the held axis is written', async () => {
    const tx = makeFakeTx(0, 0, 'personal');
    await apply(tx, 'personal');
    expect(tx.calls.set).not.toHaveProperty('accountType');
  });

  it('does not narrow a both tenant given a single-axis plan', async () => {
    const tx = makeFakeTx(0, 0, 'both');
    await apply(tx, 'business');
    expect(tx.calls.set).not.toHaveProperty('accountType');
  });

  it('writes nothing about account_type when the tenant row could not be read', async () => {
    const tx = makeFakeTx(0, 0, null);
    await apply(tx, 'both');
    expect(tx.calls.set).not.toHaveProperty('accountType');
  });
});
