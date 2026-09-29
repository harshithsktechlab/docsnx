/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE APP IS CLOSED UNTIL SETUP IS FINISHED — ON THE SERVER              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Shell has redirected an un-onboarded tenant to `/onboarding` for a long time,
 * but that was the whole enforcement: a direct call to /api/documents answered
 * normally. This is the half a browser cannot skip.
 *
 * The failure mode being tested for is not a leak — a tenant reaching its own
 * empty workspace steals nothing. It is that DocsNX keeps only metadata and puts
 * every file on the tenant's own Drive, so before the grant exists these routes
 * have nowhere to read from and nowhere to write to.
 */
import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_INCOMPLETE_CODE,
  ONBOARDING_PATH,
  requireOnboarded,
  tenantOnboarded,
} from '@/lib/onboardingGate';

const member = (tenant: any, role = 'STANDARD') => ({ id: 'u1', tenantId: 't1', role, tenant });

describe('tenantOnboarded', () => {
  it('is true once the flag is set', () => {
    expect(tenantOnboarded({ hasCompletedOnboarding: true })).toBe(true);
  });

  it('is false only for an explicit false', () => {
    expect(tenantOnboarded({ hasCompletedOnboarding: false })).toBe(false);
  });

  /**
   * Failing OPEN on a missing row is deliberate and matches every other gate
   * here: a wrong `false` locks a paying customer out of their own records,
   * which is far worse than a request slipping through while a row is absent.
   */
  it('fails open when there is no tenant row to read', () => {
    expect(tenantOnboarded(null)).toBe(true);
    expect(tenantOnboarded(undefined)).toBe(true);
    expect(tenantOnboarded({})).toBe(true);
  });
});

describe('requireOnboarded', () => {
  it('refuses a tenant that has not finished the wizard', async () => {
    const res = requireOnboarded(member({ hasCompletedOnboarding: false }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);

    const body = await res!.json();
    expect(body.code).toBe(ONBOARDING_INCOMPLETE_CODE);
    // The client has to be able to tell this from a plan lock and send the user
    // somewhere that fixes it.
    expect(body.redirectTo).toBe(ONBOARDING_PATH);
    expect(typeof body.error).toBe('string');
  });

  it('refuses the admin too — they are the one who has to finish it', () => {
    expect(requireOnboarded(member({ hasCompletedOnboarding: false }, 'TENANT_ADMIN'))).not.toBeNull();
  });

  it('lets a finished tenant through', () => {
    expect(requireOnboarded(member({ hasCompletedOnboarding: true }))).toBeNull();
  });

  it('exempts SUPER_ADMIN, which owns no tenant setup', () => {
    expect(requireOnboarded(member({ hasCompletedOnboarding: false }, 'SUPER_ADMIN'))).toBeNull();
  });

  it('leaves the 401 to the caller when there is no user', () => {
    expect(requireOnboarded(null)).toBeNull();
    expect(requireOnboarded(undefined)).toBeNull();
  });

  it('allows when the tenant row was never loaded', () => {
    expect(requireOnboarded({ id: 'u1', tenantId: 't1', role: 'STANDARD' })).toBeNull();
  });

  /**
   * 403, not 402. "You have not finished setting up" and "you have not paid"
   * have different fixes, and the client picks between the wizard and the
   * billing screen on exactly this.
   */
  it('does not answer 402, which is the plan gate s code', () => {
    expect(requireOnboarded(member({ hasCompletedOnboarding: false }))!.status).not.toBe(402);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   AND IT IS ACTUALLY WIRED IN                                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A gate nothing calls is a gate that does not exist, and the failure is an
 * ABSENT call — which has no runtime symptom, because the route still answers
 * 200 with an empty workspace behind it. Asserted at source level for the same
 * reason, and in the same style, as tests/planAxisGate.test.ts.
 */
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('the setup gate is wired at the choke points', () => {
  it('withRecordScope gates every record module', () => {
    const src = read('src/lib/records/handler.ts');
    expect(src).toContain("import { requireOnboarded } from '@/lib/onboardingGate'");
    expect(src).toContain('const setup = requireOnboarded(user);');
    expect(src).toContain('if (setup) return setup;');
  });

  it('resolveUtilityCompany gates documents, passwords, todos, contacts and the dashboard', () => {
    const src = read('src/lib/records/companyScope.ts');
    expect(src).toContain('const setup = requireOnboarded(user);');
    // Returned, not dropped — this function reports failures as `{ error }`.
    expect(src).toContain('if (setup) return { error: setup };');
  });

  it('search gates itself, having no choke point of its own', () => {
    const src = read('src/app/api/search/route.ts');
    expect(src).toContain('requireOnboarded(user)');
  });

  /**
   * ── THE ROUTES THE WIZARD ITSELF NEEDS MUST STAY OPEN ────────────────────
   *
   * Gating any of these deadlocks setup: the admin could neither finish it nor
   * leave. `/api/companies` is the one worth asserting — it is a tenant-data
   * route that LOOKS like it belongs behind the gate, and the Companies step
   * cannot work without it.
   */
  it.each([
    'src/app/api/companies/route.ts',
    'src/app/api/onboarding/complete/route.ts',
    'src/app/api/onboarding/users/route.ts',
    'src/app/api/tenants/integrations/google/route.ts',
    'src/app/api/auth/me/route.ts',
  ])('%s is left open for the wizard', (file) => {
    const src = read(file);
    expect(src).not.toContain('requireOnboarded');
    // Nor by the back door: neither choke point may be reached from here.
    expect(src).not.toContain('resolveUtilityCompany');
    expect(src).not.toContain('withRecordScope');
  });
});
