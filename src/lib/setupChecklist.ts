/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT IS STILL MISSING FROM THIS WORKSPACE                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The list behind the dashboard's "Complete Your Profile" / "Complete This
 * Company" panel, for one account.
 *
 * ── WHY THIS IS A MODULE AND NOT TWENTY LINES IN THE COMPONENT ─────────────
 * It was twenty lines in the component, and they scored the wrong thing. The
 * panel counted vault RECORDS — documents, medical, passwords, vehicles — and
 * called the result a profile, so a member whose every profile field was blank
 * read "50% Done" for having uploaded one file. Worse, the badge and the rows
 * beneath it were computed from two different expressions, and there are inputs
 * where they disagree: a household with no medical records but some investments
 * scored 100%, printed "Profile Complete!", and listed "Add Medical Records"
 * directly underneath.
 *
 * Both bugs are the same bug — a percentage and a list that are not the same
 * statement. So there is now ONE array, `done` is counted from it, and the
 * completion banner is `done === total`. The two cannot drift again because
 * there is nothing left to drift from.
 *
 * ── WHAT EARNS A ROW ───────────────────────────────────────────────────────
 * Only things that are WRONG if left undone. Not "save a password", not "add a
 * to-do", not "add a contact" — those are nudges to use a feature, they sit as
 * Quick Access cards directly above this panel already, and a household that
 * keeps no passwords here is not an incomplete household. What is left is the
 * account's identity (the profile forms), its storage (Drive, without which
 * every upload fails), and one record row: a vault holding nothing at all is
 * the one state the product cannot call set up.
 *
 * ── A ROW NOBODY CAN TICK IS NOT A ROW ─────────────────────────────────────
 * Connecting Drive is TENANT_ADMIN-only; the profile forms need `profiles:view`.
 * Listing those to a member who will be refused shows them a button that 403s
 * and a score they can never finish, so `can` filters them out entirely — the
 * denominator shrinks with the numerator and 100% stays reachable for everyone.
 *
 * ⚠ NOT A PERMISSION. `can` decides what is LISTED. Every page a row links to
 * re-checks server-side, and nothing here may become the control.
 *
 * ── FACTS, NOT VALUES ──────────────────────────────────────────────────────
 * Every input is a boolean, decided in `/api/dashboard` and never a field value.
 * `legalDetails.panNumber` and `taxDetails.gstNumber` are stored as ciphertext
 * and this file must never be handed either: "is it filled in" is answerable
 * from presence alone, and a route that shipped the values so the client could
 * check them would be putting an Aadhaar number in every browser cache to draw
 * a progress bar.
 */

/** One boolean per question `/api/dashboard` can answer about a workspace. */
export interface SetupFacts {
  /** `tenants.google_drive_enabled`. False means every upload fails. */
  driveConnected: boolean;
  /** The workspace holds at least one live, viewable document. */
  hasDocuments: boolean;
  /** The signed-in member's own `profiles` row. Personal account only. */
  profile: {
    /** `personalDetails` has date of birth, gender AND blood group. */
    personal: boolean;
    /** `legalDetails` has a PAN and an Aadhaar number (ciphertext counts). */
    legal: boolean;
  };
  /** This company's `company_profiles` row. Company account only. */
  company: {
    /** `identityDetails` has the registered legal name AND the entity type. */
    identity: boolean;
    /** `identityDetails` has the CIN/LLPIN AND the date of incorporation. */
    registration: boolean;
    /** `taxDetails` has a GSTIN AND a company PAN. TAN is optional. */
    tax: boolean;
    /** `addressDetails` has a registered address. */
    address: boolean;
    /** `contactDetails` has an email AND a phone. Website is optional. */
    contact: boolean;
  };
  /** What this member may actually do — see the note on filtering above. */
  can: {
    /** TENANT_ADMIN. Only they can grant Drive. */
    drive: boolean;
    /** `hasPermission(user, 'profiles', 'view')`. */
    profiles: boolean;
    /** At least one viewable category, i.e. the Document Manager is reachable. */
    documents: boolean;
  };
}

export interface SetupItem {
  /** Stable across renders and accounts — the component keys its icon off it. */
  key: string;
  label: string;
  /** Why it matters, in one line. Shown under the label. */
  hint: string;
  done: boolean;
  /** Where the row's button goes. Already prefixed for a company. */
  path: string;
}

export interface SetupChecklist {
  /** Every row this member may act on, done ones included. */
  items: SetupItem[];
  done: number;
  total: number;
  /** 0–100, rounded. 0 when there is nothing to ask — never NaN. */
  percent: number;
}

/**
 * The household's rows.
 *
 * `/profile` carries four tabs and only two of them are asked about: Education
 * and Shopping are conveniences (a shoe size is not missing data), while a date
 * of birth and a PAN are referenced by half the vault.
 */
function personalItems(facts: SetupFacts): SetupItem[] {
  const items: SetupItem[] = [];

  if (facts.can.drive) {
    items.push({
      key: 'drive',
      label: 'Connect Google Drive',
      hint: 'Your files live on your own Drive — uploads fail until it is linked',
      done: facts.driveConnected,
      path: '/settings',
    });
  }

  if (facts.can.profiles) {
    items.push({
      key: 'profile_personal',
      label: 'Add your personal details',
      hint: 'Date of birth, gender and blood group',
      done: facts.profile.personal,
      // The tab is named in the query so the button lands on the form it
      // promises rather than on whichever tab the page opens with.
      path: '/profile?tab=personal',
    });
    items.push({
      key: 'profile_legal',
      label: 'Add your identity numbers',
      hint: 'PAN and Aadhaar — stored encrypted',
      done: facts.profile.legal,
      path: '/profile?tab=legal',
    });
  }

  if (facts.can.documents) {
    items.push({
      key: 'documents',
      label: 'Upload your first document',
      hint: 'An ID, a deed, a policy — anything you would hate to lose',
      done: facts.hasDocuments,
      path: '/documents',
    });
  }

  return items;
}

/**
 * The company's rows.
 *
 * All five profile rows ride on one permission, `profiles` — the same key
 * /api/companies/<id>/profile gates on, because a company profile is one of the
 * shared utilities rather than a module of its own.
 *
 * Identity is split in two on purpose. "Fill in the company profile" is not
 * actionable when four of its fields are already there, and the legal name and
 * the CIN are gathered from different documents by different people.
 */
function companyItems(facts: SetupFacts, companyId: string): SetupItem[] {
  const base = `/business/${companyId}`;
  const profile = `${base}/profile`;
  const items: SetupItem[] = [];

  if (facts.can.profiles) {
    items.push({
      key: 'company_identity',
      label: 'Name the company',
      hint: 'Registered legal name and entity type',
      done: facts.company.identity,
      path: `${profile}?section=identity`,
    });
    items.push({
      key: 'company_registration',
      label: 'Add the registration details',
      hint: 'CIN / LLPIN and date of incorporation',
      done: facts.company.registration,
      path: `${profile}?section=identity`,
    });
    items.push({
      key: 'company_tax',
      label: 'Add the tax registrations',
      hint: 'GSTIN and company PAN — stored encrypted',
      done: facts.company.tax,
      path: `${profile}?section=tax`,
    });
    items.push({
      key: 'company_address',
      label: 'Add the registered address',
      hint: 'The address on the company’s filings',
      done: facts.company.address,
      path: `${profile}?section=address`,
    });
    items.push({
      key: 'company_contact',
      label: 'Add the company’s contact details',
      hint: 'Official email and phone number',
      done: facts.company.contact,
      path: `${profile}?section=contact`,
    });
  }

  if (facts.can.documents) {
    items.push({
      key: 'documents',
      label: 'Upload the company’s first document',
      hint: 'Incorporation certificate, GST registration, a licence',
      done: facts.hasDocuments,
      path: `${base}/documents`,
    });
  }

  return items;
}

/**
 * The panel's whole state, from one set of facts.
 *
 * `companyId` decides which account is being asked — the same thing that
 * decides it everywhere else on the dashboard — and it is a display concern
 * here, not a scope: the facts were already gathered for the proven workspace.
 */
export function setupChecklist(
  facts: Partial<SetupFacts> | null | undefined,
  companyId: string | null,
): SetupChecklist {
  // Defensive because the facts arrive over the network: a dashboard served by
  // a deploy older than this file has no `setup` key at all, and the panel must
  // render an empty checklist rather than throw the whole page away on
  // `undefined.drive`.
  const safe: SetupFacts = {
    driveConnected: !!facts?.driveConnected,
    hasDocuments: !!facts?.hasDocuments,
    profile: {
      personal: !!facts?.profile?.personal,
      legal: !!facts?.profile?.legal,
    },
    company: {
      identity: !!facts?.company?.identity,
      registration: !!facts?.company?.registration,
      tax: !!facts?.company?.tax,
      address: !!facts?.company?.address,
      contact: !!facts?.company?.contact,
    },
    can: {
      drive: !!facts?.can?.drive,
      profiles: !!facts?.can?.profiles,
      documents: !!facts?.can?.documents,
    },
  };
  const items = companyId ? companyItems(safe, companyId) : personalItems(safe);
  const done = items.filter((i) => i.done).length;
  const total = items.length;
  return {
    items,
    done,
    total,
    // A member with no permissions at all has nothing to complete. `0/0` is not
    // 100% — the panel renders nothing in that case rather than congratulating
    // someone on an empty list.
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

/**
 * A stored field counts as FILLED when it is a non-empty string.
 *
 * Exported because `/api/dashboard` builds the facts and this is the rule it
 * must apply. Ciphertext is a non-empty string, so an encrypted PAN passes
 * without being decrypted — but `encryptJsonKeys` deliberately writes an empty
 * string through UNCHANGED (src/lib/records/jsonFieldCrypto.ts), so a blank
 * field arrives here as `''` and must not pass. That is the whole reason this
 * is a shared function and not `!!value` at each of the fifteen call sites.
 */
export function filled(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Every one of these keys is filled. Empty list is vacuously true — so guard. */
export function allFilled(
  source: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): boolean {
  if (!source || keys.length === 0) return false;
  return keys.every((k) => filled(source[k]));
}
