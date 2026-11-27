/**
 * The 7-day free trial: what counts as unpaid, what an ended one closes, and
 * what the first purchase does to it. Each failure here looks like a working
 * app — a trial that never ends, or a paying customer still treated as one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  TRIAL_DAYS, isTrialEnded, isUnpaidTrial, trialConversionValues, trialEligibility,
  trialEndDate, trialState,
} from '@/lib/trial';
import {
  PLAN_EXPIRED_MESSAGE, TRIAL_ENDED_MESSAGE, requireActivePlan, requireActivePlanFor,
  requireTrialNotEnded,
} from '@/lib/planGate';
import { upgradeEligibility } from '@/lib/upgradePricing';
import { lockedPaths, workspaceLock } from '@/lib/workspaceLock';
import { accountMenuItems } from '@/lib/accountMenu';
import { applyPlanToTenant, type SubscriptionPlan } from '@/lib/planProvisioning';
import { creditTransactions, tenants } from '@/db/schema';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-26T10:00:00Z');
const at = (days: number, from = NOW) => new Date(from.getTime() + days * DAY);

/** An account on a trial of a combined plan, ending `endsIn` days from `from`. */
function onTrial(endsIn: number, from = NOW) {
  const ends = at(endsIn, from);
  return {
    accountType: 'both',
    trialEligible: true,
    trialPlanId: 'combo',
    trialStartedAt: at(endsIn - TRIAL_DAYS, from),
    trialEndsAt: ends,
    trialConvertedAt: null as Date | null,
    subscriptionPlanId: 'combo' as string | null,
    subscriptionExpiry: ends,
    businessPlanId: 'combo' as string | null,
    businessPlanExpiry: ends,
  };
}

describe('trial state', () => {
  it('lasts seven days', () => {
    expect(trialEndDate(NOW)).toEqual(at(7));
  });

  it('runs until its end, then is over', () => {
    expect(isTrialEnded(onTrial(1), NOW)).toBe(false);
    expect(isTrialEnded(onTrial(0), NOW)).toBe(true);
    expect(trialState(onTrial(7), NOW)).toMatchObject({ active: true, ended: false, daysLeft: 7 });
    expect(trialState(onTrial(-1), NOW)).toMatchObject({ active: false, ended: true, daysLeft: 0 });
  });

  it('is history once paid, even after its end date', () => {
    const paid = { ...onTrial(-30), trialConvertedAt: at(-31) };
    expect(isUnpaidTrial(paid)).toBe(false);
    expect(isTrialEnded(paid, NOW)).toBe(false);
    expect(trialState(paid, NOW)).toMatchObject({ active: false, ended: false, endsAt: null, planId: null });
  });

  it('is offered only to a new account that has never had a plan or a trial', () => {
    expect(trialEligibility({ trialEligible: true })).toEqual({ eligible: true });
    // Every tenant that predates 0101 reads false.
    expect(trialEligibility({ trialEligible: false })).toEqual({ eligible: false, reason: 'not_new' });
    expect(trialEligibility(onTrial(3))).toEqual({ eligible: false, reason: 'used' });
    expect(trialEligibility({ trialEligible: true, businessPlanId: 'p' }))
      .toEqual({ eligible: false, reason: 'has_plan' });
  });
});

describe('the first purchase on a trial', () => {
  it('closes the half that was tried but not bought, with a date and never null', () => {
    expect(trialConversionValues(onTrial(3), ['personal'], NOW)).toEqual({
      trialConvertedAt: NOW, businessPlanId: null, businessPlanExpiry: NOW,
    });
    expect(trialConversionValues(onTrial(3), ['business'], NOW)).toEqual({
      trialConvertedAt: NOW, subscriptionPlanId: null, subscriptionExpiry: NOW,
    });
  });

  it('clears nothing when both halves are bought', () => {
    expect(trialConversionValues(onTrial(3), ['personal', 'business'], NOW))
      .toEqual({ trialConvertedAt: NOW });
  });

  it('does nothing for an account that is not on a trial, or an order with no plan', () => {
    expect(trialConversionValues({ subscriptionPlanId: 'p' }, ['business'], NOW)).toEqual({});
    expect(trialConversionValues(onTrial(3), [], NOW)).toEqual({});
  });

  it('is never prorated against the trial term', () => {
    const tenant = { ...onTrial(3, new Date()), accountType: 'personal', businessPlanId: null };
    expect(upgradeEligibility(tenant, { id: 'p', priceYearly: 999 }))
      .toEqual({ eligible: false, reason: 'trial' });
  });
});

describe('applyPlanToTenant and trials', () => {
  const plan = {
    id: 'solo', name: 'Personal', appliesTo: 'personal', aiCredits: 500, durationDays: 365, isLifetime: false,
  } as unknown as SubscriptionPlan;

  function fakeTx(before: Record<string, unknown>) {
    const calls: { set: Record<string, unknown>; ledger: Record<string, unknown>[] } = { set: {}, ledger: [] };
    const tx = {
      execute: async () => ({ rows: [] }),
      query: { tenants: { findFirst: async () => before } },
      update: (table: unknown) => {
        expect(table).toBe(tenants);
        return {
          set: (values: Record<string, unknown>) => {
            calls.set = values;
            return { where: () => ({ returning: async () => [{ aiCreditsBalance: 500, aiCreditsBalanceBusiness: 0 }] }) };
          },
        };
      },
      insert: (table: unknown) => ({
        values: async (row: Record<string, unknown>) => { if (table === creditTransactions) calls.ledger.push(row); },
      }),
    };
    return { tx: tx as any, calls };
  }

  it('starts a trial in the ordinary plan columns, with the full credits marked as trial', async () => {
    const { tx, calls } = fakeTx({ accountType: 'personal', subscriptionPlanId: null, businessPlanId: null });
    const endsAt = at(7);
    const result = await applyPlanToTenant(tx, { tenantId: 't', plan, action: 'a', trial: { endsAt } });

    expect(result.expiry).toBe(endsAt);
    expect(calls.set).toMatchObject({
      subscriptionPlanId: 'solo', subscriptionExpiry: endsAt,
      trialPlanId: 'solo', trialEndsAt: endsAt, trialConvertedAt: null,
    });
    expect(calls.set.trialStartedAt).toBeInstanceOf(Date);
    expect(calls.ledger).toEqual([expect.objectContaining({ amount: 500, reason: 'trial_grant' })]);
  });

  it('lets the purchase decide the account type and close the unbought half', async () => {
    const { tx, calls } = fakeTx(onTrial(-1, new Date()));
    const expiry = at(365);
    await applyPlanToTenant(tx, { tenantId: 't', plan, expiry, action: 'a' });

    expect(calls.set).toMatchObject({
      accountType: 'personal',
      subscriptionPlanId: 'solo',
      subscriptionExpiry: expiry,
      businessPlanId: null,
    });
    expect(calls.set.trialConvertedAt).toBeInstanceOf(Date);
    expect(calls.set.businessPlanExpiry).toBeInstanceOf(Date);
    expect(calls.ledger[0]).toMatchObject({ reason: 'plan_grant' });
  });

  it('leaves the trial columns alone for an account that never had one', async () => {
    const { tx, calls } = fakeTx({ accountType: 'personal', subscriptionPlanId: 'old', businessPlanId: null });
    await applyPlanToTenant(tx, { tenantId: 't', plan, action: 'a' });
    expect(calls.set).not.toHaveProperty('trialConvertedAt');
    expect(calls.set).not.toHaveProperty('businessPlanId');
  });
});

describe('an ended trial leaves billing only', () => {
  const ended = () => ({ role: 'TENANT_ADMIN', tenant: onTrial(-1, new Date()) });
  const lapsedPaid = () => ({
    role: 'TENANT_ADMIN',
    tenant: { accountType: 'personal', subscriptionPlanId: 'p', subscriptionExpiry: at(-1, new Date()) },
  });

  it('402s the plan gates and says the trial ended', async () => {
    for (const response of [
      requireActivePlan(ended()), requireActivePlanFor(ended(), null), requireTrialNotEnded(ended()),
    ]) {
      expect(response?.status).toBe(402);
      expect(await response!.json()).toMatchObject({ code: 'PLAN_EXPIRED', error: TRIAL_ENDED_MESSAGE });
    }
  });

  it('keeps the old wording, and the old open doors, for a lapsed paid plan', async () => {
    expect((await requireActivePlan(lapsedPaid())!.json()).error).toBe(PLAN_EXPIRED_MESSAGE);
    expect(requireTrialNotEnded(lapsedPaid())).toBeNull();
    expect(requireTrialNotEnded({ role: 'TENANT_ADMIN', tenant: onTrial(2, new Date()) })).toBeNull();
    expect(requireTrialNotEnded({ ...ended(), role: 'SUPER_ADMIN' })).toBeNull();
  });

  it('drops Settings from the allowed pages and the menu', () => {
    expect(lockedPaths(true, true)).toEqual(['/billing']);
    expect(lockedPaths(false, true)).toEqual(['/billing/expired']);
    expect(lockedPaths(true, false)).toEqual(['/billing', '/settings']);
    expect(lockedPaths(false, false)).toEqual(['/billing/expired', '/settings']);
    expect(accountMenuItems({ role: 'TENANT_ADMIN' }, true, null, true).map((i) => i.key)).toEqual(['billing']);
    expect(accountMenuItems({ role: 'STANDARD' }, true, null, true).map((i) => i.key)).toEqual(['expired']);
  });

  it('locks every page, including a company-less one on a business-only account', () => {
    const status = {
      accountType: 'business',
      axes: { personal: { exists: false, lapsed: true }, business: { exists: true, lapsed: true } },
      trial: { ended: true },
    };
    expect(workspaceLock(status, null)).toMatchObject({ locked: true, fullyLapsed: true, otherHalfOpen: false });
  });

  /** Routes that carry no `requireActivePlan` and so need the trial gate. */
  it.each([
    'profiles', 'account/avatar', 'onboarding/users', 'onboarding/workspace', 'tenants/integrations/google',
  ])('gates /api/%s', (route) => {
    const source = readFileSync(path.resolve(__dirname, `../src/app/api/${route}/route.ts`), 'utf8');
    expect(source).toMatch(/requireTrialNotEnded\((user|adminUser)\)/);
  });
});
