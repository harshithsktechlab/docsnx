/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   What a workspace is called before anybody has been asked               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/register` used to ask for the workspace name first, above everything else —
 * the very first thing a stranger was asked, before they had seen a single
 * screen of the product, and the one answer a tenant admin could never change
 * afterwards (only PUT /api/admin/tenants/[id] can rename a tenant).
 *
 * So the question moved into the onboarding wizard, where the person has an
 * account and some context, and this fills the gap in between: `tenants.name` is
 * NOT NULL and the row is created at registration, several minutes before the
 * wizard's Welcome step gets to ask.
 *
 * Used in both places, which is the point — the route writes this value, and the
 * wizard prefills its input with whatever the row already holds, so the name on
 * screen and the name in the database are never two different guesses.
 */

/** `tenants.name` is varchar(255); a longer value is a failed insert, not a truncated one. */
const MAX_TENANT_NAME = 255;

/**
 * "Amit Sharma" → "Amit Sharma's Workspace".
 *
 * The fallback is 'My Workspace' rather than something clever: it is the exact
 * string /api/dashboard already substitutes for a missing tenant name, so a
 * workspace with nothing to derive from reads the same everywhere it appears.
 */
export function defaultWorkspaceName(fullName: string | null | undefined): string {
  const trimmed = (fullName || '').trim();
  if (!trimmed) return 'My Workspace';

  const derived = `${trimmed}’s Workspace`;
  // Only a 240-character name can reach this, but the column would reject it
  // outright and take a whole registration with it.
  return derived.length > MAX_TENANT_NAME ? trimmed.slice(0, MAX_TENANT_NAME) : derived;
}

/**
 * What the PERSONAL side of an account is called.
 *
 * `tenants.name` is the account / business name; on a combo tenant the personal
 * side can carry its own (`personal_workspace_name`, 0089). NULL falls back to
 * `name`, which is also the answer for personal-only and business-only tenants —
 * they never set it — so this is safe to call for every account type.
 */
export function personalWorkspaceName(
  tenant: { name?: string | null; personalWorkspaceName?: string | null } | null | undefined,
): string {
  return (tenant?.personalWorkspaceName || '').trim() || (tenant?.name || '').trim() || 'My Workspace';
}

/** True when two workspace names would read as the same name (trim + case-insensitive). */
export function namesCollide(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE SAME BOX ASKS TWO DIFFERENT QUESTIONS                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The Welcome step runs for every account type — `STEP_WELCOME` is in both
 * PERSONAL_STEPS and BUSINESS_STEPS — and it asked all of them "What should we
 * call this workspace?" over the placeholder "e.g. Sharma Household".
 *
 * On a business account that is the wrong question in two ways. `tenants.name`
 * is the ACCOUNT's name, not a company's: companies are named on the NEXT step
 * and each one carries its own name into its own workspace, so a business admin
 * answering a household-shaped question reasonably believed they had just named
 * their company. And the step runs BEFORE they have been told companies exist,
 * so nothing on screen could correct them.
 *
 * ── WHY THE NAME STILL HAS TO BE ASKED OF A BUSINESS ACCOUNT ───────────────
 * Skipping the step there was the other option, and it is worse. The tenant
 * name is not decorative: it sits under the wordmark in the rail and the mobile
 * top bar on EVERY page — including inside `/business/<id>/…`, where the
 * switcher chip is showing the company name beside it — it prints on invoices
 * (`billingName ?? name`), it names the account on the plan-lock screens, and
 * it is the string an admin must type back to confirm an erasure when they have no mobile number on file. A business
 * account that never answered would be living under a name derived from the
 * admin's own at sign-up and shown all of those places.
 *
 * So the question stays and the wording moves.
 *
 * ── "ASK AN ADMINISTRATOR" WAS NOT TRUE ────────────────────────────────────
 * The old helper line ended "You can ask an administrator to change it later".
 * The person reading it IS the tenant admin, and no tenant-facing rename
 * exists: PUT /api/admin/tenants/[id] is the only route that renames a tenant
 * and it is SUPER_ADMIN-only. Since then PUT /api/tenants/workspace gives the
 * admin a rename, and the line points at it.
 */
export interface WorkspaceNameCopy {
  /** The question above the input. */
  label: string;
  /** An example of the kind of name being asked for. */
  placeholder: string;
  /** The line under the input: where the name shows, and how to change it. */
  helper: string;
  /**
   * The noun the label used, for the client-side "too short" toast. Without it
   * the toast says "workspace" under a label that just asked about an account.
   */
  noun: string;
}

/** Said the same way in all three variants, because it is true in all three. */
const RENAME = 'You can change it later from your dashboard or Settings.';

/** Where the name shows up, in the three places a customer will actually meet it. */
const PERSONAL_REACH = 'This is the name you’ll see across the app — in the sidebar, '
  + 'on your dashboard and on your invoices.';
const ACCOUNT_REACH = 'This is your account’s umbrella name — it appears in the sidebar '
  + 'and on your invoices.';
/** The correction the business variants exist to make. */
const COMPANIES_NEXT = 'You’ll name your companies on the next step, and each company’s '
  + 'own name is what you’ll see inside its workspace.';

/**
 * @param accountType `tenants.account_type` — 'personal' | 'business' | 'both'.
 *                    Anything else falls through to the 'both' wording, which
 *                    is the safe superset: it names both halves, so an account
 *                    type this build does not recognise is over-explained
 *                    rather than told about a half it may not have.
 */
export function workspaceNameCopy(accountType: string | null | undefined): WorkspaceNameCopy {
  if (accountType === 'personal') {
    return {
      label: 'What should we call this workspace?',
      placeholder: 'e.g. Sharma Personal',
      helper: `${PERSONAL_REACH} ${RENAME}`,
      noun: 'workspace',
    };
  }

  if (accountType === 'business') {
    return {
      label: 'What should we call this account?',
      placeholder: 'e.g. Sharma Group',
      helper: `${ACCOUNT_REACH} ${COMPANIES_NEXT} ${RENAME}`,
      noun: 'account',
    };
  }

  // 'both', and anything unrecognised. The personal side has its own name since
  // 0089 (see `personalNameCopy`), so this one names the business half only.
  return {
    label: 'What should we call your business account?',
    placeholder: 'e.g. Sharma Group',
    helper: `${ACCOUNT_REACH} Your personal side is named separately. `
      + `${COMPANIES_NEXT} ${RENAME}`,
    noun: 'business account',
  };
}

/**
 * The second question a combo account is asked: what its PERSONAL side is
 * called. Asked in addition to `workspaceNameCopy('both')`, and the two answers
 * must differ — see `namesCollide`.
 */
export const personalNameCopy: WorkspaceNameCopy = {
  label: 'What should we call your personal workspace?',
  placeholder: 'e.g. Sharma Personal',
  helper: `${PERSONAL_REACH} It must be different from your business account name. ${RENAME}`,
  noun: 'personal workspace',
};
