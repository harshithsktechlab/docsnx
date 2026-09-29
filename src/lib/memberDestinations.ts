/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHERE A MEMBER ADDED DURING ONBOARDING ACTUALLY GOES                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The wizard's Invite Members step asked for a name, a mobile and a temporary
 * password, and never said WHICH account it was adding them to. On a `both`
 * tenant — a household AND one or more companies — that is a question with two
 * real answers and the step named neither, so every member silently landed in
 * the household and had to be re-created from /business/<id>/users afterwards.
 *
 * ── THE STEP DID NOT HAVE A DESTINATION TO NAME ────────────────────────────
 * This is why the fix is not a label. POST /api/onboarding/users wrote no
 * `account_scope` and no `company_access` row at all, so there was nothing for
 * copy to describe truthfully. This module is the missing half: the list of
 * places a member can go, and the two body fields that say which one was
 * chosen. The route re-resolves both — nothing here is trusted over the wire.
 *
 * ── WHY IT IS NOT IN THE COMPONENT ─────────────────────────────────────────
 * Same reason `companySlots.ts` exists next to the Companies step: the wizard
 * is `src/app/onboarding/page.js`, and vitest cannot parse JSX out of a `.js`
 * file, so anything left in there is untestable. The rules below decide which
 * half of an account a person is filed under, which is worth pinning.
 */

/** A company as both /api/auth/me and /api/companies return it. */
export interface DestinationCompany {
  id: string;
  name: string;
}

/** One place a new member can be added. */
export interface MemberDestination {
  /** `null` is the household; otherwise the company's id. */
  id: string | null;
  /**
   * The bare NAME — the account's own, or the company's. This is the one that
   * goes inside a sentence (`membersStepBlurb`, the success toast, the submit
   * button), where a qualifier would read as part of the name.
   */
  label: string;
  /**
   * What the SELECTOR row reads, which is not always the name.
   *
   * On a combo account the household row carried the raw tenant name — and
   * that name is the ACCOUNT's, not the household's (see
   * `workspaceNameCopy` in src/lib/workspaceName.ts). So the step listed
   * "Sharma Group" directly above "Acme Trading Pvt Ltd" as though the admin
   * were choosing between two companies, when the first row is the personal
   * half of the account and the rest are its companies.
   *
   * Qualified only when there is something to tell it apart FROM. A personal
   * account's single row is its household by definition and needs no prefix;
   * so does a combo account that has not added a company yet. The word is
   * `Personal` because that is what the workspace switcher already calls this
   * half (src/app/components/WorkspaceSwitcher.jsx) — a second vocabulary for
   * the same half is the confusion, not the fix.
   */
  rowLabel: string;
  /**
   * Which half this destination belongs to, in the vocabulary `users.account_scope`
   * and `defaultPermissionsFor` already speak.
   */
  scope: 'personal' | 'business';
}

/**
 * The name to show when the tenant's own has not loaded yet.
 *
 * Lower case and generic on purpose: it sits in a sentence ("…added to your
 * household"), and a placeholder that looked like a proper noun would read as
 * the account having been named that.
 */
const HOUSEHOLD_FALLBACK = 'your household';

/**
 * Every destination this account genuinely has, in the order the step lists
 * them.
 *
 * ── AN ACCOUNT TYPE IS NOT A PREFERENCE ────────────────────────────────────
 * A `personal` tenant has no company to add anyone to and a `business` one has
 * no household, so in both cases there is exactly one kind of answer and the
 * step must not offer the other. Only `both` has a choice to make — which is
 * the whole of the ambiguity this module exists to remove.
 *
 * ── AN EMPTY LIST IS A MEANINGFUL ANSWER ───────────────────────────────────
 * A business account whose companies have not loaded — or that somehow reached
 * this step with none — yields NO destinations rather than a household one.
 * There is nowhere to put a member, and inventing a household to hold them is
 * exactly the misfiling this replaces. The step renders that as "add a company
 * first", not as a working form.
 */
export function memberDestinations(
  accountType: string | null | undefined,
  workspaceName: string | null | undefined,
  companies: readonly DestinationCompany[] | null | undefined,
): MemberDestination[] {
  const householdName = String(workspaceName || '').trim() || HOUSEHOLD_FALLBACK;
  const household: MemberDestination = {
    id: null,
    label: householdName,
    // Unqualified for now; the combo branch below is the only one that has
    // companies to tell it apart from.
    rowLabel: householdName,
    scope: 'personal',
  };

  if (accountType === 'personal') return [household];

  const list = (Array.isArray(companies) ? companies : [])
    .filter((c): c is DestinationCompany => Boolean(c && c.id))
    .map((c): MemberDestination => {
      const name = String(c.name || '').trim() || 'Untitled company';
      // A company row is already named after the thing it is, so the row and
      // the sentence read the same.
      return { id: c.id, label: name, rowLabel: name, scope: 'business' };
    });

  // A business-only tenant has no household half at all — offering one would be
  // filing an employee somewhere the account cannot reach.
  if (accountType === 'business') return list;

  // 'both', and anything unrecognised. The household leads: it is the safe
  // default below, and a list whose default is not first reads as mis-selected.
  //
  // And only HERE is its row qualified — a combo account with no company yet
  // renders one row, which needs no telling apart.
  if (list.length === 0) return [household];
  return [{ ...household, rowLabel: `Personal — ${household.label}` }, ...list];
}

/**
 * Which destination is selected before the admin touches anything.
 *
 * The household when there is one, for the reason POST /api/users gives for the
 * same default: forgetting to grant a company is a support request, and
 * forgetting to revoke one is a disclosure. `users.account_scope` is immutable
 * after creation (src/db/schema.ts), so the cheap-to-fix direction is the only
 * responsible way to be wrong.
 *
 * Returns `null` for an empty list too — indistinguishable from "the household"
 * by value, which is why callers test `destinations.length`, not this.
 */
export function defaultDestinationId(list: readonly MemberDestination[]): string | null {
  return list.length > 0 ? list[0].id : null;
}

/** The destination with this id, or null when the list does not hold it. */
export function findDestination(
  list: readonly MemberDestination[],
  id: string | null,
): MemberDestination | null {
  return list.find((d) => d.id === id) ?? null;
}

/**
 * The sentence under "Invite Members".
 *
 * It carries the destination in BOTH shapes of the step. With one destination
 * there is no selector to read it off, so this is the only thing that names
 * where the form posts; with several, it explains what the selector is for.
 */
export function membersStepBlurb(
  chosen: MemberDestination | null,
  list: readonly MemberDestination[],
): string {
  if (list.length === 0) {
    return 'Add a company first — every business member works on one, so there is '
      + 'nowhere to put them yet.';
  }

  const tail = ' You can set a temporary password for them now.';

  if (list.length === 1) {
    const only = list[0];
    return only.scope === 'business'
      ? `Add the people who work on ${only.label}, so they can log in and reach its documents.${tail}`
      : `Add the members of ${only.label}, so they can log in and reach shared documents.${tail}`;
  }

  if (!chosen) {
    return `Choose which part of your account each person belongs to, then add them.${tail}`;
  }

  return chosen.scope === 'business'
    ? `Adding to ${chosen.label}. They will reach that company's documents, and not your household's.${tail}`
    : `Adding to ${chosen.label}. They will reach your household's documents, and none of your companies'.${tail}`;
}

/**
 * The two fields the POST carries, derived rather than assembled by the page.
 *
 * A hint, not an instruction: the route resolves the scope from the tenant and
 * re-resolves the company ids against it, because `company_access` carries no
 * tenant column of its own and a body is not evidence of anything.
 */
export function destinationPayload(chosen: MemberDestination | null): {
  accountScope: 'personal' | 'business';
  companyIds: string[];
} {
  if (!chosen || chosen.scope !== 'business' || !chosen.id) {
    return { accountScope: 'personal', companyIds: [] };
  }
  return { accountScope: 'business', companyIds: [chosen.id] };
}
