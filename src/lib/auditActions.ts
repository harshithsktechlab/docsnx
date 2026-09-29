/**
 * Canonical audit-action vocabulary and parsing helpers.
 *
 * This module is deliberately free of any `db` / `pg` import so it can be
 * imported from client components (the /audit-logs page) as well as from
 * server routes. The writer itself lives in `src/lib/audit.ts`.
 *
 * Canonical form is `<entity>.<verb>` — e.g. `document.create`.
 *
 * Historical rows are NOT rewritten, so three legacy formats remain in the
 * table forever and `parseAuditAction` must keep understanding them:
 *   - verb-first SCREAMING_SNAKE  `CREATE_DOCUMENT`
 *   - noun-first past tense       `TAX_COMPLIANCE_CREATED`
 *   - dot-case                    `payment.edit_manual`
 *
 * It also owns the WORDING of the trail — `auditSentence` below is the single
 * writer of every `details` string. Before it existed, 75 call sites each wrote
 * their own line: "Uploaded", "Added", "Created" and "Saved" all meant create,
 * eight sites dumped raw `JSON.stringify` blobs into the Details column, and a
 * reader was shown `bank_investments/itr_form16` and a bare UUID where a
 * category name and a person's name belonged.
 */

import { categoryDisplay } from './documentCategories';

function crud<E extends string>(entity: E) {
  return {
    create: `${entity}.create` as const,
    update: `${entity}.update` as const,
    delete: `${entity}.delete` as const,
    /**
     * Reading the SEALED tier — a reveal, not an ordinary open. Ordinary views
     * are not audited (they happen on every page render); decrypting protected
     * fields is the act worth recording.
     */
    view: `${entity}.view` as const,
  };
}

/** Canonical action strings. Import these instead of writing literals. */
export const ACTIONS = {
  // ─── The record modules ────────────────────────────────────────────────────
  // One entry per module, and the entity name IS the module name — the same
  // name the taxonomy, the permission check and the vault folder use. The
  // entries this replaces were a nineteenth vocabulary: `medical_record` for
  // `medical`, `contract` AND `rental` for `rentals`, `trading_demat` for
  // `trading`, `utility_bill` for `utility_bills`.
  //
  // Historical rows keep their old strings; `parseAuditAction` below already
  // has to understand three legacy formats and now understands these too.
  documents: {
    ...crud('documents'),
    /**
     * A bulk ZIP download. Reading one document is not audited — it happens on
     * every page view — but decrypting a whole selection out of the vault in a
     * single archive is the kind of movement a tenant admin should be able to
     * see afterwards.
     */
    bulk_export: 'documents.bulk_export',
  },
  medical: crud('medical'),
  lic_mediclaim: crud('lic_mediclaim'),
  bank_info: crud('bank_info'),
  trading: crud('trading'),
  investments: crud('investments'),
  loans_debt: crud('loans_debt'),
  vehicles: crud('vehicles'),
  tax_compliance: crud('tax_compliance'),
  wills_estate: crud('wills_estate'),
  warranty: crud('warranty'),
  rentals: crud('rentals'),
  utility_bills: crud('utility_bills'),
  employment_payroll: crud('employment_payroll'),

  // The business scopes. `recordAction` builds these strings dynamically from
  // the URL, so the generic handler needs no entry — but the two must agree, and
  // tests/moduleVocabularyReach.test.ts asserts they do.
  biz_registration: crud('biz_registration'),
  biz_tax: crud('biz_tax'),
  biz_finance: crud('biz_finance'),
  biz_banking: crud('biz_banking'),
  biz_licenses: crud('biz_licenses'),
  biz_compliance: crud('biz_compliance'),
  biz_contracts: crud('biz_contracts'),
  biz_hr: crud('biz_hr'),
  biz_ip: crud('biz_ip'),
  biz_insurance: crud('biz_insurance'),
  biz_governance: crud('biz_governance'),
  biz_procurement: crud('biz_procurement'),
  biz_sales: crud('biz_sales'),
  biz_operations: crud('biz_operations'),

  // Not record modules — their own tables, their own actions.
  company: crud('company'),
  document_category: crud('document_category'),
  password: crud('password'),
  emergency_contact: crud('emergency_contact'),
  todo: crud('todo'),

  // ─── Identity & tenancy ────────────────────────────────────────────────────
  user: {
    ...crud('user'),
    onboarding_create: 'user.onboarding_create',
    // An admin turning a member's sign-in off or back on. Not a removal: the
    // member stays in the workspace either way (users.sign_in_disabled_at).
    sign_in_disable: 'user.sign_in_disable',
    sign_in_enable: 'user.sign_in_enable',
  },
  profile: { update: 'profile.update' },
  tenant: {
    ...crud('tenant'),
    register: 'tenant.register',
    // Setup finished — the Drive grant was proven against Google and the
    // workspace opened. Distinct from `tenant.update`, which is a settings edit.
    onboarding_complete: 'tenant.onboarding_complete',
  },
  /**
   * ── PARTIAL ERASURE, AND WHY THESE ROWS ARE SPECIAL ──────────────────────
   *
   * Deleting HALF an account. Not `tenant.delete`, which is the whole-tenant
   * erasure and writes no audit row at all — `audit_logs` is tenant-scoped and
   * cascades away microseconds later, so there is nothing left to read it (see
   * /api/account/delete). Here the tenant survives, so the row survives, and
   * these are the only trace that a workspace ever existed.
   *
   * ⚠ Every one of these MUST be written with `companyId: null`, at tenant
   * level, even when erasing one company. `audit_logs.company_id` is ON DELETE
   * CASCADE, so a row filed under Acme is destroyed along with Acme — the
   * erasure would erase its own record of itself.
   */
  account: {
    erase_personal: 'account.erase_personal',
    erase_business: 'account.erase_business',
    erase_company: 'account.erase_company',
  },
  auth: {
    password_reset_requested: 'auth.password_reset_requested',
    password_reset_completed: 'auth.password_reset_completed',
    verify_email_otp: 'auth.verify_email_otp',
    /**
     * A correct password met an unverified account and a code went out on both
     * channels. Worth its own key: it is the only audit line proving a member
     * created by an admin was actually challenged before their first session.
     */
    first_login_otp_sent: 'auth.first_login_otp_sent',
  },

  // ─── Integrations ──────────────────────────────────────────────────────────
  google_drive: {
    connect: 'google_drive.connect',
    disconnect: 'google_drive.disconnect',
    revoke: 'google_drive.revoke',
    sync: 'google_drive.sync',
    integration_enabled: 'google_drive.integration_enabled',
    integration_disabled: 'google_drive.integration_disabled',
    /**
     * An OPERATOR ran a maintenance script against this tenant's Drive.
     *
     * Every other action here is a tenant acting on their own account. This one
     * is us acting on theirs, which is precisely why it is worth a row: before
     * it, a diagnostic could read a tenant's whole folder tree and leave no
     * trace that anyone had looked.
     *
     * Accountability, not access control — anyone with server access can call
     * the Drive API directly and never reach this. It makes legitimate
     * operator work reviewable; it stops nobody.
     */
    operator_inspect: 'google_drive.operator_inspect',
  },
  backup: { restore: 'backup.restore' },
  whatsapp: {
    config_updated: 'whatsapp.config_updated',
    test_message: 'whatsapp.test_message',
  },
  /**
   * The outbound mail gateway, mirroring `whatsapp` above.
   *
   * `test_email` earns a key for the same reason `whatsapp.test_message` does:
   * it causes real outbound mail from the platform's own address. It also
   * leaves the only durable record of WHEN someone last proved the transport
   * worked — the question that took a month to get asked after the settings
   * were re-entered wrong and every verification code silently stopped.
   */
  smtp: {
    config_updated: 'smtp.config_updated',
    test_email: 'smtp.test_email',
  },
  system_config: {
    upload_limit_updated: 'system_config.upload_limit_updated',
  },

  // ─── AI ────────────────────────────────────────────────────────────────────
  ai: {
    generate_followups: 'ai.generate_followups',
    update_context: 'ai.update_context',
    optimize_context: 'ai.optimize_context',
  },

  // ─── Billing ───────────────────────────────────────────────────────────────
  payment: {
    verify: 'payment.verify',
    capture_webhook: 'payment.capture_webhook',
    fail_webhook: 'payment.fail_webhook',
    edit_manual: 'payment.edit_manual',
    delete_manual: 'payment.delete_manual',
  },
  subscription_plan: {
    create: 'subscription_plan.create',
    update: 'subscription_plan.update',
    deactivate: 'subscription_plan.deactivate',
    /** The hard delete — only ever reaches a plan nothing references. */
    delete: 'subscription_plan.delete',
  },
  addon: {
    create: 'addon.create',
    update: 'addon.update',
    deactivate: 'addon.deactivate',
    grant: 'addon.grant',
  },
  credits: {
    admin_adjust: 'credits.admin_adjust',
    addon_granted_webhook: 'credits.addon_granted_webhook',
    trial_granted: 'credits.trial_granted',
  },
  discount_code: crud('discount_code'),
} as const;

/**
 * Legacy SCREAMING_SNAKE actions whose FIRST token is the verb.
 * `CREATE_DOCUMENT` -> verb "create", entity "document".
 */
const LEADING_VERBS = new Set([
  'create', 'update', 'delete', 'register', 'restore',
  'grant', 'deactivate', 'generate', 'optimize',
]);

/**
 * Legacy SCREAMING_SNAKE actions whose LAST token is the verb, usually past
 * tense. `TAX_COMPLIANCE_CREATED` -> verb "create", entity "tax_compliance".
 * Values normalise past tense onto the canonical verb where one exists.
 */
const TRAILING_VERBS: Record<string, string> = {
  created: 'create',
  updated: 'update',
  deleted: 'delete',
  // Every reveal written before the `view` verb existed used the scope's own
  // spelling — `TAX_COMPLIANCE_REVEALED`, `PASSWORD_REVEALED`. Without this
  // they parse as an entity with no verb and render as a colourless badge of
  // their own, one per module, next to the new `<module>.view` rows.
  revealed: 'view',
  connected: 'connect',
  disconnected: 'disconnect',
  revoked: 'revoke',
  verified: 'verify',
  granted: 'grant',
  adjusted: 'adjust',
  successful: 'complete',
  requested: 'request',
};

export interface ParsedAuditAction {
  /** Snake-case entity the event concerns, e.g. "document". */
  entity: string;
  /** Canonical verb, e.g. "create". Empty string when unrecognised. */
  verb: string;
}

/**
 * Split an audit action string into entity + verb, understanding both the
 * canonical `<entity>.<verb>` form and the three legacy formats.
 *
 * Never throws: an unrecognised string yields the whole value as `entity`
 * and an empty `verb`, so the UI can still render something sensible.
 */
export function parseAuditAction(action: string): ParsedAuditAction {
  if (!action) return { entity: '', verb: '' };

  // Canonical (and legacy dot-case) form.
  const dot = action.indexOf('.');
  if (dot > 0) {
    return {
      entity: action.slice(0, dot).toLowerCase(),
      verb: action.slice(dot + 1).toLowerCase(),
    };
  }

  const tokens = action.toLowerCase().split('_').filter(Boolean);
  if (tokens.length === 0) return { entity: '', verb: '' };
  if (tokens.length === 1) return { entity: tokens[0], verb: '' };

  const first = tokens[0];
  if (LEADING_VERBS.has(first)) {
    return { entity: tokens.slice(1).join('_'), verb: first };
  }

  const last = tokens[tokens.length - 1];
  const mapped = TRAILING_VERBS[last];
  if (mapped) {
    return { entity: tokens.slice(0, -1).join('_'), verb: mapped };
  }

  return { entity: tokens.join('_'), verb: '' };
}

/**
 * Badge variant for an action, derived from its parsed verb rather than by
 * substring-matching the raw string (the old approach mis-coloured e.g.
 * `UPDATE_...` rows that merely contained "CREATE" elsewhere).
 *
 * Variants must exist in `src/components/ui/badge.jsx`.
 */
export function auditActionVariant(action: string): 'success' | 'secondary' | 'destructive' | 'outline' {
  const { verb } = parseAuditAction(action);

  if (verb === 'create' || verb === 'register' || verb === 'connect' || verb === 'grant') {
    return 'success';
  }
  if (
    verb === 'delete' || verb === 'revoke' || verb === 'disconnect' || verb === 'deactivate'
    // The partial erasures. Unrecoverable, so they read louder than a delete,
    // not quieter — which is what the default 'outline' would have made them.
    || verb.startsWith('erase_')
  ) {
    return 'destructive';
  }
  if (verb === 'update' || verb === 'complete' || verb === 'verify' || verb === 'view') {
    return 'secondary';
  }
  return 'outline';
}

/** Title-case a snake_case or space-separated key: `bank_info` -> "Bank Info". */
function titleCase(key: string): string {
  return key
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * What each verb reads as in the trail — PAST TENSE, because an audit row is
 * always a thing that already happened.
 *
 * One label per act, so the same word never describes two acts and two words
 * never describe one: create is "Added" everywhere, whether the record arrived
 * by upload, by form or by bulk scan.
 */
const VERB_LABELS: Record<string, string> = {
  create: 'Added',
  update: 'Updated',
  delete: 'Deleted',
  view: 'Viewed',
  bulk_export: 'Downloaded',
  restore: 'Restored',
  connect: 'Connected',
  disconnect: 'Disconnected',
  revoke: 'Disconnected',
  integration_enabled: 'Enabled',
  integration_disabled: 'Disabled',
  sync: 'Synced',
  register: 'Registered',
  grant: 'Granted',
  deactivate: 'Deactivated',
  verify: 'Verified',
  complete: 'Completed',
  request: 'Requested',
  onboarding_create: 'Added',
  sign_in_disable: 'Turned off sign-in for',
  sign_in_enable: 'Turned on sign-in for',
  onboarding_complete: 'Completed',
  edit_manual: 'Updated',
  delete_manual: 'Deleted',
  capture_webhook: 'Captured',
  fail_webhook: 'Failed',
  addon_granted_webhook: 'Granted',
  trial_granted: 'Granted',
  admin_adjust: 'Adjusted',
  config_updated: 'Updated',
  test_message: 'Tested',
  test_email: 'Tested',
  generate_followups: 'Generated',
  /**
   * The partial erasures. "Erased" rather than "Deleted" on purpose: the trail
   * already uses Deleted for the ordinary soft-delete that a tenant can undo,
   * and these three cannot be undone by anyone. A word people read differently
   * is worth having for the one action with no way back.
   */
  erase_personal: 'Erased',
  erase_business: 'Erased',
  erase_company: 'Erased',
  update_context: 'Refreshed',
  optimize_context: 'Optimised',
  password_reset_requested: 'Requested',
  password_reset_completed: 'Completed',
  verify_email_otp: 'Verified',
  first_login_otp_sent: 'Sent',
  operator_inspect: 'Inspected',
};

/**
 * What each entity reads as. A literal map rather than a lookup through
 * `moduleRegistry` / `RECORD_SCOPES` on purpose: this module is imported by the
 * /audit-logs CLIENT component, and those pull in the permission machinery.
 *
 * Only entries whose title-cased key would read wrong need to be here; anything
 * missing falls through to `titleCase`, which is why legacy entities the map was
 * never told about still render.
 */
const ENTITY_LABELS: Record<string, string> = {
  documents: 'Documents',
  companies: 'Company',
  company: 'Company',
  document: 'Documents',
  document_category: 'Document Category',
  medical: 'Medical',
  medical_record: 'Medical',
  lic_mediclaim: 'LIC & Mediclaim',
  bank_info: 'Bank Accounts',
  trading: 'Trading & Demat',
  trading_demat: 'Trading & Demat',
  investments: 'Investments',
  loans_debt: 'Loans & Debt',
  vehicles: 'Vehicles',
  tax_compliance: 'Tax & Compliance',
  wills_estate: 'Wills & Estate',
  warranty: 'Warranties',
  rentals: 'Rentals',
  rental: 'Rentals',
  contract: 'Rentals',
  utility_bills: 'Utility Bills',
  utility_bill: 'Utility Bills',
  employment_payroll: 'Employment & Payroll',

  // The business taxonomy. Without these, `titleCase` renders the module key
  // and the audit trail reads "Biz Hr".
  biz_registration: 'Business Registration',
  biz_tax: 'Business Tax',
  biz_finance: 'Financial & Accounting',
  biz_banking: 'Banking & Credit',
  biz_licenses: 'Licenses & Permits',
  biz_compliance: 'Compliance & Filings',
  biz_contracts: 'Contracts & Agreements',
  biz_hr: 'Human Resources',
  biz_ip: 'Intellectual Property',
  biz_insurance: 'Business Insurance',
  biz_governance: 'Corporate Governance',
  biz_procurement: 'Vendor & Procurement',
  biz_sales: 'Sales & Marketing',
  biz_operations: 'Operations & Assets',
  password: 'Passwords',
  emergency_contact: 'Important Contact',
  todo: 'To-Do',
  user: 'Member',
  profile: 'Profile',
  tenant: 'Account',
  auth: 'Sign-in',
  google_drive: 'Google Drive',
  backup: 'Backup',
  whatsapp: 'WhatsApp',
  smtp: 'Email (SMTP)',
  ai: 'AI',
  payment: 'Payment',
  subscription_plan: 'Plan',
  addon: 'Add-on',
  credits: 'AI Credits',
  discount_code: 'Discount Code',
};

/** The plain-words name of what an action concerns, e.g. "Google Drive". */
export function auditEntityLabel(action: string): string {
  const { entity } = parseAuditAction(action);
  if (!entity) return '';
  return ENTITY_LABELS[entity] ?? titleCase(entity);
}

/** The plain-words, past-tense name of what was done, e.g. "Added". */
export function auditVerbLabel(action: string): string {
  const { verb } = parseAuditAction(action);
  if (!verb) return '';
  return VERB_LABELS[verb] ?? titleCase(verb);
}

/**
 * The badge and filter label for an action, e.g. `documents.create` ->
 * "Documents Added".
 *
 * Past tense, not the raw verb: the trail used to read "DOCUMENTS CREATE" next
 * to "TAX COMPLIANCE CREATE", which is neither English nor consistent with the
 * sentence in the Details column beside it.
 */
export function formatAuditAction(action: string): string {
  const label = [auditEntityLabel(action), auditVerbLabel(action)].filter(Boolean).join(' ');
  return label || action;
}

/**
 * How a taxonomy category is NAMED in the trail: "ITR filings and Form 16", not
 * `bank_investments/itr_form16`.
 *
 * `categoryDisplay` returns undefined for a pair that is not in the seed, so an
 * unseeded or renamed pair degrades to a title-cased key rather than vanishing —
 * a log line that silently drops where the record lives is worse than one
 * naming it a little awkwardly.
 */
export function categoryPhrase(
  moduleKey?: string | null,
  documentKey?: string | null,
): string | null {
  if (!moduleKey || !documentKey) return null;
  const display = categoryDisplay({ moduleKey, documentKey });
  return display?.documentName ?? titleCase(documentKey);
}

/** The facts one audit sentence is built from. */
export interface AuditSubject {
  /**
   * What kind of thing this is, in the reader's words — "document",
   * "password", "member". Lowercase; the sentence capitalises nothing but its
   * first word, which is always the verb.
   */
  kind: string;
  /**
   * The thing's own name — a title, a code, a person's name. NEVER an id: a
   * UUID in this field is the defect this whole module exists to remove.
   */
  name?: string | null;
  /** Where it lives, already in display words — see `categoryPhrase`. */
  category?: string | null;
  /** Whose it is, BY NAME. Never a user id. */
  member?: string | null;
  /**
   * The exception worth stating: "replaced the attached file", "from a bulk
   * scan". Appended after an em dash. Omit it for the ordinary case — a note on
   * every line is a note on none.
   */
  note?: string | null;
}

/** `in` for a thing that stays put, `from` for one being taken out. */
function preposition(verb: string): string {
  // An export is a removal as far as the sentence is concerned: the bytes left
  // the vault, even though the record stayed behind.
  if (verb === 'delete' || verb === 'bulk_export') return 'from';
  if (verb === 'create') return 'to';
  return 'in';
}

/**
 * The ONE writer of `audit_logs.details`.
 *
 * Every clause is optional except the verb and the kind, and an absent clause
 * leaves no trace — so a password with no category and no member reads
 * `Deleted password "HDFC Netbanking".` and not a line littered with "in" and
 * "for" and nothing after them.
 *
 * Keep sensitive values out of what you pass here: audit rows are not encrypted
 * and are never purged (see the note on `AuditEntry.details` in ./audit.ts).
 */
export function auditSentence(verb: string, s: AuditSubject): string {
  const parts: string[] = [VERB_LABELS[verb] ?? titleCase(verb), s.kind];

  // Quotes delimit the name, so a name that already contains one would end it
  // early and read as two fields. Straight quotes become typographic ones
  // rather than being stripped: the title is what the user typed.
  if (s.name) parts.push(`"${String(s.name).replace(/"/g, '”')}"`);
  if (s.category) parts.push(`${preposition(verb)} ${s.category}`);
  if (s.member) parts.push(`for ${s.member}`);

  const sentence = `${parts.join(' ')}.`;
  return s.note ? `${sentence.slice(0, -1)} — ${s.note}.` : sentence;
}

/**
 * The canonical action for a record module, e.g. `recordAction('medical',
 * 'create')` → `medical.create`.
 *
 * Exists because the module name is not knowable at author time in the generic
 * handler — it comes from the URL — so `ACTIONS.<module>` cannot be written
 * literally there. Without this the handler fell back to building strings by
 * hand, which is how a twentieth spelling gets born.
 */
export function recordAction(
  module: string,
  verb: 'create' | 'update' | 'delete' | 'view',
): string {
  return `${module}.${verb}`;
}
