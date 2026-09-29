/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ONBOARDING STEP THAT DID NOT SAY WHERE IT WAS PUTTING PEOPLE       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * "Invite Members" asked for a name, a mobile and a temporary password. On a
 * combo account — a household AND companies — it named neither half, and the
 * route behind it wrote no `account_scope` and no `company_access` row, so the
 * honest answer to "which account is this for?" was "the household, always".
 *
 * Two failures are possible in the list below and they are not symmetric.
 *
 * Offering a destination the account does not have is the worse one: a
 * household row on a business-only tenant files an employee somewhere with no
 * permissions and no roster, and `account_scope` cannot be edited afterwards —
 * the fix is deleting the member and starting again.
 *
 * Offering too few is recoverable but strands the step: an empty list means the
 * form is not drawn at all, so it must mean "there is genuinely nowhere to put
 * anyone", never "the companies have not loaded".
 */
import { describe, it, expect } from 'vitest';
import {
  memberDestinations, defaultDestinationId, findDestination,
  membersStepBlurb, destinationPayload,
} from '@/lib/memberDestinations';

const ACME = { id: 'c-acme', name: 'Acme Trading Pvt Ltd' };
const BETA = { id: 'c-beta', name: 'Beta Exports' };

describe('memberDestinations — which halves an account actually has', () => {
  it('offers a personal account its household alone, under its own name', () => {
    const list = memberDestinations('personal', 'Sharma Household', []);
    expect(list).toEqual([
      { id: null, label: 'Sharma Household', rowLabel: 'Sharma Household', scope: 'personal' },
    ]);
  });

  it('never offers a personal account a company, even if one is passed', () => {
    // A personal tenant cannot hold companies at all; a stale list from a
    // previous account type must not become a destination.
    const list = memberDestinations('personal', 'Sharma Household', [ACME]);
    expect(list).toHaveLength(1);
    expect(list[0].scope).toBe('personal');
  });

  it('offers a business-only account its companies and NO household', () => {
    // The bug this replaces: a wizard-added member on a business tenant got
    // account_scope 'personal' and no grant, so they could reach nothing.
    const list = memberDestinations('business', 'Acme Group', [ACME, BETA]);
    expect(list.map((d) => d.id)).toEqual([ACME.id, BETA.id]);
    expect(list.every((d) => d.scope === 'business')).toBe(true);
  });

  it('offers a combo account the household FIRST, then every company', () => {
    const list = memberDestinations('both', 'Sharma Household', [ACME, BETA]);
    expect(list.map((d) => d.label)).toEqual(['Sharma Household', ACME.name, BETA.name]);
    expect(list.map((d) => d.scope)).toEqual(['personal', 'business', 'business']);
  });

  it('qualifies the household ROW once companies sit beside it', () => {
    // `workspaceName` is the ACCOUNT's name on a combo tenant, so an unqualified
    // row listed it directly above "Acme Trading Pvt Ltd" as though the admin
    // were choosing between two companies. 'Personal' is the word the workspace
    // switcher already uses for this half.
    const list = memberDestinations('both', 'Sharma Group', [ACME]);
    expect(list[0].rowLabel).toBe('Personal — Sharma Group');
    expect(list[1].rowLabel).toBe(ACME.name);
  });

  it('leaves `label` bare, because it goes inside sentences', () => {
    // The blurb, the success toast and the submit button all read "… to
    // {label}". A qualifier there would read as part of the name.
    const list = memberDestinations('both', 'Sharma Group', [ACME]);
    expect(list[0].label).toBe('Sharma Group');
    expect(membersStepBlurb(list[0], list)).toContain('Adding to Sharma Group.');
  });

  it('does not qualify a row that has nothing to be told apart from', () => {
    // One destination means no selector is drawn at all; a prefix would be
    // telling the admin apart from a company they do not have.
    expect(memberDestinations('personal', 'Sharma Household', [])[0].rowLabel)
      .toBe('Sharma Household');
    expect(memberDestinations('both', 'Sharma Group', [])[0].rowLabel)
      .toBe('Sharma Group');
  });

  it('gives a business account with no company NOWHERE to file anyone', () => {
    // Not a household — that is precisely the misfiling. An empty list is what
    // tells the step to draw "add a company first" instead of a working form.
    expect(memberDestinations('business', 'Acme Group', [])).toEqual([]);
    expect(memberDestinations('business', 'Acme Group', null)).toEqual([]);
  });

  it('still offers the household while a combo account has no company yet', () => {
    const list = memberDestinations('both', 'Sharma Household', []);
    expect(list).toHaveLength(1);
    expect(list[0].scope).toBe('personal');
  });

  it('names the household generically until the tenant name has loaded', () => {
    // It sits inside a sentence, so the placeholder must not read as a name the
    // account was actually given.
    expect(memberDestinations('personal', '', [])[0].label).toBe('your household');
    expect(memberDestinations('personal', null, [])[0].label).toBe('your household');
    expect(memberDestinations('personal', '   ', [])[0].label).toBe('your household');
  });

  it('skips a company with no id rather than offering an unpostable row', () => {
    const list = memberDestinations('business', 'Acme', [ACME, { id: '', name: 'Ghost' } as any, null as any]);
    expect(list.map((d) => d.id)).toEqual([ACME.id]);
  });

  it('treats an unknown account type as a combo one', () => {
    // The permissive direction: the household leads and is the default, so an
    // account type this build does not recognise cannot silently file an
    // employee into a company nobody chose.
    const list = memberDestinations(undefined, 'Sharma Household', [ACME]);
    expect(list[0].scope).toBe('personal');
    expect(list).toHaveLength(2);
  });
});

describe('defaultDestinationId — the safe direction to be wrong in', () => {
  it('defaults a combo account to the household', () => {
    // `account_scope` is immutable after creation: a wrong 'personal' is a grant
    // an admin can add later, a wrong 'business' is a member they must delete.
    const list = memberDestinations('both', 'Sharma Household', [ACME, BETA]);
    expect(defaultDestinationId(list)).toBeNull();
  });

  it('defaults a business account to its first company', () => {
    const list = memberDestinations('business', 'Acme Group', [ACME, BETA]);
    expect(defaultDestinationId(list)).toBe(ACME.id);
  });

  it('returns null for an empty list', () => {
    expect(defaultDestinationId([])).toBeNull();
  });
});

describe('findDestination — an id that is no longer in the list', () => {
  it('finds the household by its null id', () => {
    const list = memberDestinations('both', 'Sharma Household', [ACME]);
    expect(findDestination(list, null)?.scope).toBe('personal');
  });

  it('returns null for a company that is gone, so the caller can fall back', () => {
    // The step chains this into the default; returning the first row here
    // instead would silently move a selection the admin had made.
    const list = memberDestinations('business', 'Acme Group', [ACME]);
    expect(findDestination(list, BETA.id)).toBeNull();
  });
});

describe('destinationPayload — the hint the route re-resolves', () => {
  it('sends the household as personal with no companies', () => {
    expect(destinationPayload({ id: null, label: 'Sharma Household', rowLabel: 'Sharma Household', scope: 'personal' }))
      .toEqual({ accountScope: 'personal', companyIds: [] });
  });

  it('sends a company as business, naming exactly that one', () => {
    expect(destinationPayload({ id: ACME.id, label: ACME.name, rowLabel: ACME.name, scope: 'business' }))
      .toEqual({ accountScope: 'business', companyIds: [ACME.id] });
  });

  it('falls back to personal when there is no destination at all', () => {
    // A business request with no company is refused by the route; falling back
    // to 'business' here would turn a UI gap into a 400 the admin cannot read.
    expect(destinationPayload(null)).toEqual({ accountScope: 'personal', companyIds: [] });
  });

  it('never sends business without an id', () => {
    expect(destinationPayload({ id: null, label: 'x', scope: 'business' } as any))
      .toEqual({ accountScope: 'personal', companyIds: [] });
  });
});

describe('membersStepBlurb — the step says where it is posting', () => {
  it('names the household on a personal account', () => {
    const list = memberDestinations('personal', 'Sharma Household', []);
    expect(membersStepBlurb(list[0], list)).toContain('Sharma Household');
  });

  it('names the company on a single-company business account', () => {
    // There is no selector at length 1, so this sentence is the ONLY thing that
    // names the destination.
    const list = memberDestinations('business', 'Acme Group', [ACME]);
    expect(membersStepBlurb(list[0], list)).toContain(ACME.name);
  });

  it('names the chosen half on a combo account, and says what it excludes', () => {
    const list = memberDestinations('both', 'Sharma Household', [ACME]);
    const business = membersStepBlurb(list[1], list);
    expect(business).toContain(ACME.name);
    expect(business).toMatch(/not your household/i);

    const personal = membersStepBlurb(list[0], list);
    expect(personal).toContain('Sharma Household');
    expect(personal).toMatch(/none of your companies/i);
  });

  it('tells a company-less business account what to do instead', () => {
    expect(membersStepBlurb(null, [])).toMatch(/add a company first/i);
  });
});
