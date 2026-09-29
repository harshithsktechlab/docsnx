/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PLAN GATE IS ASKED AFTER THE WORKSPACE IS KNOWN                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every company-aware route used to call `requireActivePlan(user)` at the TOP of
 * its handler, before it had resolved which company it was serving — so it
 * answered for the household on a request about a company, and a lapsed personal
 * plan closed companies the customer was still paying for.
 *
 * The fix is not in those routes. It is in the two choke points they all pass
 * through, and it only works while those choke points keep asking:
 *
 *   withRecordScope        every record module, sub-category route, withCategory
 *   resolveUtilityCompany  passwords, to-dos, contacts, documents, follow-up,
 *                          the dashboard, analysis, search, the scan routes
 *
 * Asserted at source level because the failure is an ABSENT or MISPLACED call,
 * which has no runtime symptom: the route still answers 200, with the wrong
 * plan's verdict behind it. Same technique, and the same reason, as
 * tests/personalRouteCompanyScope.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('withRecordScope gates the workspace, not the tenant', () => {
  const src = read('src/lib/records/handler.ts');

  it('calls requireActivePlanFor with the resolved company', () => {
    expect(src).toContain('requireActivePlanFor(user, company.companyId)');
  });

  /**
   * ORDER IS THE WHOLE BUG. `gateCompany` is what produces `company.companyId`,
   * so a gate above it can only be reading the household.
   */
  it('gates AFTER gateCompany has resolved and proven the company', () => {
    const resolvedAt = src.indexOf('const company = await gateCompany(');
    const gatedAt = src.indexOf('requireActivePlanFor(user, company.companyId)');
    expect(resolvedAt).toBeGreaterThan(-1);
    expect(gatedAt).toBeGreaterThan(-1);
    expect(
      gatedAt,
      'the plan gate must come after gateCompany, or it answers for the '
        + 'household on a request about a company',
    ).toBeGreaterThan(resolvedAt);
  });

  // The tenant-wide gate must not linger here as well: it would fire first and
  // reintroduce exactly the behaviour above.
  it('no longer calls the bare requireActivePlan', () => {
    expect(src).not.toMatch(/requireActivePlan\(user\)/);
  });
});

describe('resolveUtilityCompany gates the workspace it just proved', () => {
  const src = read('src/lib/records/companyScope.ts');

  it('gates on the resolved company', () => {
    expect(src).toContain('requireActivePlanFor(user, companyId ?? null)');
  });

  /**
   * AFTER `hasCompanyAccess`, so a company the caller cannot reach is a 403
   * rather than an invitation to renew a subscription that would not help them.
   */
  it('gates after access is proven, not before', () => {
    const provedAt = src.indexOf('await hasCompanyAccess(user, companyId)');
    const gatedAt = src.indexOf('requireActivePlanFor(user, companyId ?? null)');
    expect(provedAt).toBeGreaterThan(-1);
    expect(gatedAt).toBeGreaterThan(provedAt);
  });

  it('returns the 402 rather than dropping it', () => {
    expect(src).toMatch(/if \(gate\) return \{ error: gate \};/);
  });
});

/**
 * Two routes resolve their company by hand rather than through
 * `resolveUtilityCompany`, so they inherit no gate and have to ask for
 * themselves. They are easy to miss precisely because they look like every other
 * company-aware route from the outside.
 */
describe('the routes that bypass the resolver gate themselves', () => {
  it.each([
    ['src/app/api/analysis/route.ts', 'requireActivePlanFor(user, companyId ?? null)'],
    ['src/app/api/companies/[id]/profile/route.ts', 'requireActivePlanFor(user, id)'],
  ])('%s asks for its own workspace', (file, call) => {
    expect(read(file)).toContain(call);
  });
});

/**
 * ── WHY THE EARLY `requireActivePlan(user)` CALLS WERE LEFT ALONE ───────────
 *
 * They used to be wrong, and are not any more: `requireActivePlan` now means
 * "every axis this tenant HAS is dead", so it can only fire when the whole
 * account is unpaid — at which point everything should be closed anyway. It is a
 * strictly weaker pre-check sitting in front of the precise one.
 *
 * This asserts the property that makes that safe, so nobody reverts the gate to
 * reading one axis and quietly re-breaks ~70 call sites at once.
 */
describe('the account-level gate asks every axis', () => {
  const src = read('src/lib/planGate.ts');

  it('requireActivePlan is built on tenantFullyExpired', () => {
    const fn = src.slice(
      src.indexOf('export function requireActivePlan('),
      src.indexOf('export function requireActivePlanFor('),
    );
    expect(fn).toContain('tenantFullyExpired(user.tenant)');
    // NOT the personal columns alone, which is what it used to read and what
    // meant a business-only tenant never locked at all.
    expect(fn).not.toMatch(/planStatus\(user\.tenant\)\.isExpired/);
    /**
     * And NOT the "unpaid" variant. The server gate has never refused a tenant
     * for having no plan yet — one part-way through signup has none — so
     * swapping these two would 402 every route between registration and
     * checkout.
     */
    expect(fn).not.toContain('tenantFullyLapsed(');
  });

  it.each([
    ['tenantFullyExpired'],
    ['tenantFullyLapsed'],
  ])('%s consults only the axes the account type declares', (name) => {
    const fn = src.slice(src.indexOf(`export function ${name}(`));
    expect(fn).toContain('axesForAccountType(tenant?.accountType)');
    expect(fn).toContain('.every(');
  });

  /**
   * The pair exists because "expired" and "unpaid" have different consumers —
   * the gates and the client lock. Collapsing them breaks a different thing in
   * each direction, so both must stay exported and distinct.
   */
  it('keeps the expired/unpaid pair distinct', () => {
    expect(src).toContain('export function tenantFullyExpired(');
    expect(src).toContain('export function tenantFullyLapsed(');
    expect(src).toContain('export function workspaceExpired(');
    expect(src).toContain('export function workspaceLapsed(');
  });
});
