/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE SWITCHER OFFERS EXACTLY THE WORKSPACES THAT EXIST                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Three failures this guards, all of which render as a working-looking menu:
 *
 *  1. A personal-only tenant offered a Business row. There is no company behind
 *     it, so the row is a dead end in the one control whose whole job is saying
 *     where you are.
 *  2. A business-only tenant offered Personal. `accountType` is what decides
 *     this, not `companies.length` — a business account has no household half
 *     even though /dashboard still resolves.
 *  3. A chip reading "undefined" when the company id in the URL names one the
 *     member cannot reach. The id is untrusted by design (see Shell.js), so
 *     this case is normal, not exceptional.
 *  4. A member offered the half of the account they were not added to. The
 *     tenant having both halves does not mean this member does — someone added
 *     to work on a company has no household records, no household permissions
 *     and no household roster, and a Personal row for them is a link to a
 *     dashboard that 403s module by module.
 *
 * Tested here rather than through the component, which is JSX and therefore
 * unimportable by vitest in this repo.
 */
import { describe, it, expect } from 'vitest';
import {
  workspaceMenu,
  defaultCompanyId,
  businessHref,
  activeWorkspace,
  activeCompanyFrom,
  companyFromPath,
  isAccountPath,
  companyHome,
  ACCOUNT_PATHS,
  PERSONAL_HOME,
  type Company,
} from '@/lib/workspaceNav';

const ACME: Company = { id: '3f4e0b2a-0000-4000-8000-000000000001', name: 'Acme Traders' };
const REDPLUTO: Company = { id: '3f4e0b2a-0000-4000-8000-000000000002', name: 'Redpluto' };

describe('workspaceMenu', () => {
  it('draws no switcher for a personal-only tenant', () => {
    const menu = workspaceMenu('personal', []);
    expect(menu.rowCount).toBe(0);
    expect(menu.hasPersonal).toBe(false);
    expect(menu.companies).toEqual([]);
  });

  it('ignores stray companies on a personal account', () => {
    // Belt and braces: the account type is the authority, so a personal tenant
    // that somehow carries a company row still gets no business half.
    expect(workspaceMenu('personal', [ACME]).rowCount).toBe(0);
  });

  it('offers Personal and one Business row to a both account', () => {
    const menu = workspaceMenu('both', [ACME, REDPLUTO]);
    expect(menu.hasPersonal).toBe(true);
    expect(menu.companies).toEqual([ACME, REDPLUTO]);
    // Two companies, still ONE top-level row — that is the whole point of the
    // second level.
    expect(menu.rowCount).toBe(2);
  });

  it('offers only Business to a business account', () => {
    const menu = workspaceMenu('business', [ACME]);
    expect(menu.hasPersonal).toBe(false);
    expect(menu.rowCount).toBe(1);
  });

  it('draws nothing for a business account that can reach no company', () => {
    // A member whose company access has not been granted yet. An empty menu is
    // the honest answer; a Business row would open onto nothing.
    expect(workspaceMenu('business', []).rowCount).toBe(0);
  });

  it('survives a missing or malformed companies payload', () => {
    for (const bad of [null, undefined, 'nope' as any]) {
      expect(workspaceMenu('both', bad).companies).toEqual([]);
      expect(workspaceMenu('both', bad).rowCount).toBe(1);
    }
  });
});

describe('businessHref', () => {
  it('goes straight in when there is one company', () => {
    expect(businessHref([ACME])).toBe(companyHome(ACME.id));
  });

  it('expands instead when there are several', () => {
    expect(businessHref([ACME, REDPLUTO])).toBeNull();
  });

  it('expands rather than linking nowhere when there are none', () => {
    expect(businessHref([])).toBeNull();
  });
});

describe('activeWorkspace', () => {
  it('reads personal when the URL carries no company', () => {
    for (const absent of [null, undefined, '']) {
      const active = activeWorkspace(absent, [ACME]);
      expect(active.kind).toBe('personal');
      expect(active.companyId).toBeNull();
    }
  });

  it('names the company the URL carries', () => {
    const active = activeWorkspace(ACME.id, [ACME, REDPLUTO]);
    expect(active).toEqual({ kind: 'business', companyId: ACME.id, companyName: 'Acme Traders' });
  });

  it('has no name for a company this member cannot reach', () => {
    // The chip falls back to a bare "Business"; the page behind the id 403s on
    // its own, which is where that belongs.
    const active = activeWorkspace('someone-elses-company', [ACME]);
    expect(active.kind).toBe('business');
    expect(active.companyName).toBeNull();
  });
});

describe('the two workspace homes', () => {
  it('are the paths the shell already routes to', () => {
    expect(PERSONAL_HOME).toBe('/dashboard');
    expect(companyHome(ACME.id)).toBe(`/business/${ACME.id}/dashboard`);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A MEMBER SEES THE ACCOUNT THEY WERE ADDED TO, AND ONE ACCOUNT ONLY     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `users.account_scope` is a DISPLAY axis, not a gate — the real enforcement is
 * the seeded permission split (tests/memberAccountScope.test.ts) plus
 * `company_access`. What it decides here is whether the other half is offered
 * at all, so that a single-account member experiences the app as having one.
 *
 * The admin exemption is the load-bearing half of this. A TENANT_ADMIN creates
 * the companies and `hasCompanyAccess` short-circuits for them; consulting
 * their `account_scope` would lock the owner of the workspace out of half of it.
 */
const MEMBER = (accountScope: string) => ({ role: 'STANDARD', accountScope });
const ADMIN = { role: 'TENANT_ADMIN', accountScope: 'personal' };

describe('workspaceMenu, for one member', () => {
  it('offers a business member their companies and no Personal row', () => {
    const menu = workspaceMenu('both', [ACME, REDPLUTO], MEMBER('business'));
    expect(menu.hasPersonal).toBe(false);
    expect(menu.companies).toEqual([ACME, REDPLUTO]);
  });

  it('offers a personal member the household and no companies', () => {
    // Belt and braces: `accessibleCompanies` already returns nothing for them,
    // so this is the second of two independent answers rather than the only one.
    const menu = workspaceMenu('both', [ACME], MEMBER('personal'));
    expect(menu.hasPersonal).toBe(true);
    expect(menu.companies).toEqual([]);
    expect(menu.hasChoice).toBe(false);
  });

  it('treats a missing account_scope as personal', () => {
    // The column defaults to 'personal', which is what every row was before it
    // existed. A member fetched by an older client sends `undefined`, and the
    // safe direction to be wrong in is the one that shows fewer workspaces.
    const menu = workspaceMenu('both', [ACME], { role: 'STANDARD' });
    expect(menu.hasPersonal).toBe(true);
    expect(menu.companies).toEqual([]);
  });

  it('never narrows a TENANT_ADMIN, whatever their own scope says', () => {
    const menu = workspaceMenu('both', [ACME, REDPLUTO], ADMIN);
    expect(menu.hasPersonal).toBe(true);
    expect(menu.companies).toEqual([ACME, REDPLUTO]);
  });

  it('is unchanged when no viewer is supplied', () => {
    expect(workspaceMenu('both', [ACME])).toEqual(workspaceMenu('both', [ACME], ADMIN));
  });
});

describe('hasChoice — whether the chip is worth drawing', () => {
  it('is true for a tenant holding both halves', () => {
    expect(workspaceMenu('both', [ACME], ADMIN).hasChoice).toBe(true);
  });

  it('is true for a business-only tenant with two companies', () => {
    // `rowCount` is 1 there — Business is ONE row however many sit under it —
    // so a chip gated on `rowCount > 1` would strand the second company.
    const menu = workspaceMenu('business', [ACME, REDPLUTO], ADMIN);
    expect(menu.rowCount).toBe(1);
    expect(menu.hasChoice).toBe(true);
  });

  it('is false for a business-only tenant with one company', () => {
    expect(workspaceMenu('business', [ACME], ADMIN).hasChoice).toBe(false);
  });

  it('is false for a business member who can reach exactly one company', () => {
    // One destination, and they are already standing in it. A chip here opens
    // onto a single row naming where the user already is.
    expect(workspaceMenu('both', [ACME], MEMBER('business')).hasChoice).toBe(false);
  });

  it('is false for a personal-only tenant', () => {
    expect(workspaceMenu('personal', [], ADMIN).hasChoice).toBe(false);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE WORKSPACE TO OPEN WHEN THE URL NAMES NONE                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The regression this exists for: an admin erases their personal account, the
 * tenant becomes `business`, and every page that names no company — /settings,
 * /dashboard — still read as the household. The rail, the badge counts and the
 * quick actions all described a half that had just been deleted, and because
 * `hasChoice` is false with one company there was no chip to escape with. The
 * company looked deleted. It was only unreachable.
 */
describe('defaultCompanyId', () => {
  it('is null for a tenant that HAS a household', () => {
    // The household is the right default there, and this must not move it.
    expect(defaultCompanyId(workspaceMenu('both', [ACME, REDPLUTO], ADMIN))).toBeNull();
    expect(defaultCompanyId(workspaceMenu('personal', [], ADMIN))).toBeNull();
  });

  it('is the company for a business-only tenant — the erased-personal case', () => {
    expect(defaultCompanyId(workspaceMenu('business', [ACME], ADMIN))).toBe(ACME.id);
  });

  it('picks the first company when a business-only tenant has several', () => {
    // Arbitrary but not wrong: any company beats a household that does not
    // exist, and the switcher IS drawn here (hasChoice is true) to move on.
    expect(defaultCompanyId(workspaceMenu('business', [ACME, REDPLUTO], ADMIN))).toBe(ACME.id);
  });

  it('is null for a business-only tenant with no company left', () => {
    // Nowhere to send them. The caller falls back to the household rather than
    // to `undefined`, which is the shape every consumer already handles.
    expect(defaultCompanyId(workspaceMenu('business', [], ADMIN))).toBeNull();
  });

  it('sends a business member to their company, not to a household they lack', () => {
    expect(defaultCompanyId(workspaceMenu('both', [ACME], MEMBER('business')))).toBe(ACME.id);
  });

  it('leaves a personal member on the household', () => {
    expect(defaultCompanyId(workspaceMenu('both', [ACME], MEMBER('personal')))).toBeNull();
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH WORKSPACE THE SHELL IS IN, ON A PAGE THAT HAS NO COMPANY IN IT   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Settings, Billing, AI Credits and Audit Logs belong to the TENANT: one
 * /settings and one subscription however many companies sit under them, so none
 * of them has a `/business/<id>/…` route. The shell read the open workspace out
 * of the path alone, so opening any of the four from inside a company moved the
 * whole shell home mid-session — the chip, the rail, the bottom nav, the quick
 * actions and the follow-up / to-do badge counts all flipped to Personal on a
 * click the user made to open Settings.
 *
 * `accountMenuItems` puts `?company=` on those links; this reads it back.
 */
describe('activeCompanyFrom', () => {
  const COMPANIES = [ACME, REDPLUTO];
  const q = (search: string) => new URLSearchParams(search);

  describe('the path wins', () => {
    it('reads the company out of a business route', () => {
      expect(activeCompanyFrom(`/business/${ACME.id}/dashboard`, null, COMPANIES)).toBe(ACME.id);
      expect(activeCompanyFrom(`/business/${ACME.id}`, null, COMPANIES)).toBe(ACME.id);
    });

    it('does NOT validate the path id, and must not start', () => {
      // Deliberate, and older than this function: the id in a business route is
      // untrusted, every business route re-proves it with `hasCompanyAccess`,
      // and a company the member cannot reach renders an empty rail and 403s on
      // the way to any data. Validating here would silently paint a PERSONAL
      // rail over a business page instead, which is a worse lie.
      expect(activeCompanyFrom('/business/not-a-company/dashboard', null, COMPANIES))
        .toBe('not-a-company');
    });

    it('ignores the query when the path already names a company', () => {
      expect(activeCompanyFrom(`/business/${ACME.id}/todos`, q(`company=${REDPLUTO.id}`), COMPANIES))
        .toBe(ACME.id);
    });
  });

  describe('?company= on an account page', () => {
    it('keeps the workspace on each of the four', () => {
      for (const path of ACCOUNT_PATHS) {
        expect(activeCompanyFrom(path, q(`company=${ACME.id}`), COMPANIES)).toBe(ACME.id);
      }
    });

    it('accepts a raw query string as well as URLSearchParams', () => {
      // Shell hands it `useSearchParams()`; a test or a caller reading
      // `window.location.search` hands it a string.
      expect(activeCompanyFrom('/settings', `?company=${ACME.id}`, COMPANIES)).toBe(ACME.id);
    });

    it('carries the axis param on /billing without tripping over it', () => {
      expect(activeCompanyFrom('/billing', q(`axis=business&company=${ACME.id}`), COMPANIES))
        .toBe(ACME.id);
    });
  });

  describe('everything that must fall through to the household', () => {
    it('rejects a company this member cannot reach', () => {
      // The whole reason this half is validated and the path half is not:
      // nothing behind /settings would ever contradict a bogus id, so an
      // unvalidated one would paint a company rail — with that company's name
      // in the chip — over a page that has nothing to do with it.
      expect(activeCompanyFrom('/settings', q(`company=${REDPLUTO.id}`), [ACME])).toBeNull();
      expect(activeCompanyFrom('/settings', q('company=someone-elses-id'), COMPANIES)).toBeNull();
    });

    it("reads 'personal' as the household, not as a company", () => {
      // That is the literal value the Personal tab on /audit-logs writes — see
      // PERSONAL_PARAM in WorkspaceTabs.jsx.
      expect(activeCompanyFrom('/audit-logs', q('company=personal'), COMPANIES)).toBeNull();
    });

    it('handles an absent, empty or missing query', () => {
      expect(activeCompanyFrom('/settings', q('company='), COMPANIES)).toBeNull();
      expect(activeCompanyFrom('/settings', q('page=2'), COMPANIES)).toBeNull();
      expect(activeCompanyFrom('/settings', null, COMPANIES)).toBeNull();
      expect(activeCompanyFrom('/settings', undefined, COMPANIES)).toBeNull();
    });

    it('ignores ?company= anywhere but the four account pages', () => {
      // A stray param on a module page is not a workspace instruction. Honouring
      // it there would make every link in the app a potential workspace switch.
      for (const path of ['/dashboard', '/documents', '/modules/vehicle', '/billing/expired']) {
        expect(activeCompanyFrom(path, q(`company=${ACME.id}`), COMPANIES)).toBeNull();
      }
    });

    it('survives a null pathname and an empty company list', () => {
      // /api/auth/me has not answered yet: `companies` is [] and nothing can be
      // validated against it, so the chrome stays personal until it has.
      expect(activeCompanyFrom(null, q(`company=${ACME.id}`), COMPANIES)).toBeNull();
      expect(activeCompanyFrom('/settings', q(`company=${ACME.id}`), [])).toBeNull();
      expect(activeCompanyFrom('/settings', q(`company=${ACME.id}`), null)).toBeNull();
    });
  });

  it('feeds activeWorkspace, which is what the chip reads', () => {
    // The end-to-end shape: /settings opened from Acme still says Acme.
    const id = activeCompanyFrom('/settings', q(`company=${ACME.id}`), COMPANIES);
    expect(activeWorkspace(id, COMPANIES)).toEqual({
      kind: 'business',
      companyId: ACME.id,
      companyName: ACME.name,
    });
  });
});

describe('companyFromPath', () => {
  it('reads the company out of a business route and nothing else', () => {
    expect(companyFromPath(`/business/${ACME.id}/documents`)).toBe(ACME.id);
    expect(companyFromPath('/dashboard')).toBeNull();
    expect(companyFromPath('/businesses/x')).toBeNull();
    expect(companyFromPath('/business')).toBeNull();
    expect(companyFromPath(null)).toBeNull();
  });

  it('is the id the plan lock runs on, which is why Shell needs it separately', () => {
    // On an account page the chrome follows `?company=`, but the LOCK must not:
    // locking on it would make /audit-logs?company=acme redirect to
    // /billing?expired=1 the moment the business half lapsed, closing a door
    // EXPIRED_PATHS_* deliberately holds open.
    const search = new URLSearchParams(`company=${ACME.id}`);
    expect(activeCompanyFrom('/audit-logs', search, [ACME])).toBe(ACME.id);
    expect(companyFromPath('/audit-logs')).toBeNull();
  });
});

describe('isAccountPath', () => {
  it('matches the four exactly', () => {
    for (const path of ACCOUNT_PATHS) expect(isAccountPath(path)).toBe(true);
  });

  it('does not match a sub-page or the lock screen', () => {
    // `/billing/expired` is a gate, not one of the four: the lock screen is a
    // door out of a lapsed account, not a view of a workspace.
    expect(isAccountPath('/billing/expired')).toBe(false);
    expect(isAccountPath('/settings/anything')).toBe(false);
    expect(isAccountPath('/dashboard')).toBe(false);
    expect(isAccountPath(null)).toBe(false);
  });
});
