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
 * it is the string an admin must type back to confirm an erasure. A business
 * account that never answered would be living under a name derived from the
 * admin's own at sign-up and shown all of those places.
 *
 * So the question stays and the wording moves.
 *
 * ── "ASK AN ADMINISTRATOR" WAS NOT TRUE ────────────────────────────────────
 * The old helper line ended "You can ask an administrator to change it later".
 * The person reading it IS the tenant admin, and no tenant-facing rename
 * exists: PUT /api/admin/tenants/[id] is the only route that renames a tenant
 * and it is SUPER_ADMIN-only. The line now points at support, which is what
 * actually happens.
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
const RENAME = 'Contact DocsNX support if you need it changed later.';

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
      placeholder: 'e.g. Sharma Household',
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

  // 'both', and anything unrecognised. The extra clause is the one thing a
  // combo account needs that a business-only one does not: the umbrella name is
  // ALSO what its personal half is called, which is why the household row on
  // the Members step reads "Personal — <this name>".
  return {
    label: 'What should we call this account?',
    placeholder: 'e.g. Sharma Group',
    helper: `${ACCOUNT_REACH} It is also what your personal side is called. `
      + `${COMPANIES_NEXT} ${RENAME}`,
    noun: 'account',
  };
}
