/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   LEGACY FIELD MAP — camelCase route bodies → snake_case taxonomy keys   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `splitRecordFields` (src/lib/vault/fieldSplitter.ts) decides what gets sealed
 * by intersecting a record's keys with the category's encrypt list. That list
 * holds snake_case taxonomy fieldKeys (`employee_name`, `policy_number`), while
 * every module route hands it the raw camelCase form body (`employeeName`,
 * `policyNumber`). The intersection was therefore EMPTY: nothing was ever
 * sealed, and PII sat in the open tier of the Drive JSON in the clear.
 *
 * This table is the translation that closes that gap. It is also what the
 * legacy API adapters, the bulk-scan importer, backup restore and the DPDPA
 * export all read, so the vocabulary is defined once rather than six times.
 *
 * ── CANDIDATES, NOT A SINGLE NAME ──────────────────────────────────────────
 * The right taxonomy key depends on the CATEGORY, not just the module.
 * `insurance/life_policies` has `sum_assured`; `insurance/health_policies` has
 * `sum_insured`. A single name would land the value under a key that category's
 * policy does not seal — silently back to the original bug. So each mapping
 * lists candidates in priority order and `resolveFieldKey` picks the first one
 * the target category actually declares (see `fieldsFor` in
 * src/lib/documentCategoryFields.ts).
 *
 * ── UNLISTED KEYS ARE NOT AN ERROR ─────────────────────────────────────────
 * A record may carry keys no category declares — `insurance_expiry`,
 * `puc_expiry`, the `has_712_extract` flags. Those are dates and booleans, which
 * the classification rule keeps OPEN anyway, so falling through to the first
 * candidate name is correct. What must never happen is a PII value under an
 * unsealed key: mark those `seal: true` and `tests/fieldMap.test.ts` fails the
 * build if the resolved key is not `isPii` in the module's default category.
 *
 * ── NEVER ──────────────────────────────────────────────────────────────────
 *  ✗ Point `seal: true` at a key that is `isPii: false`. Fix the dictionary
 *    instead — the dictionary is the policy, this file is only the routing.
 *  ✗ Rename a `legacy` key. It is the wire format the 18 existing pages send.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { CategoryKey } from '@/lib/documentCategories';
import { fieldsFor, identifierFields } from '@/lib/documentCategoryFields';

/**
 * The part of a field spec key resolution reads.
 *
 * Structural so a caller can hand over either the compiled dictionary entry or
 * the stored `document_category_fields.fields` row without converting between
 * them — they differ in the extra keys they carry, not in these two.
 */
export interface ResolvableSpec {
  readonly fieldKey: string;
  readonly isIdentifier?: boolean;
}

export interface FieldMapping {
  /** The camelCase key exactly as the legacy route or form sends it. */
  readonly legacy: string;
  /**
   * Taxonomy fieldKey candidates, most specific first. The first one declared
   * by the target category wins; with no match, `candidates[0]` is used so the
   * key is at least normalised to snake_case.
   */
  readonly candidates: readonly string[];
  /**
   * Asserted intent: this value is PII and MUST resolve onto an `isPii` key.
   * Enforced by tests/fieldMap.test.ts — it is a build-time guarantee, not a
   * runtime switch. The actual sealing is done by the category's stored policy.
   */
  readonly seal?: boolean;
  /**
   * This legacy field IS the record's identity, whatever the category calls it.
   *
   * Set on the ONE generic field a form asks for when it cannot know the
   * category in advance. `candidates` can only ever list keys someone thought
   * of; this says "and otherwise, use whatever this category considers its
   * identifier" — see `resolveFieldKey`. Do not set it on a mapping that names
   * a specific fact (`policyNumber`, `chassisNumber`): those are candidates,
   * and retargeting one onto an unrelated identifier would silently overwrite
   * a different field.
   */
  readonly identifier?: boolean;
  /** Also emit a `blindIndex()` under this key, for dedup and exact search. */
  readonly hash?: boolean;
  /** How to derive the display-safe value shown in lists. */
  readonly mask?: 'tail' | 'username';
  /** Surface this date as a follow-up reminder under this label. */
  readonly reminder?: string;
}

/**
 * Keyed by module — which since migration 0015 is one name for all three roles:
 * the taxonomy `module_key`, the `hasPermission` key, and the vault module.
 */
export const MODULE_FIELD_MAP: Readonly<Record<string, readonly FieldMapping[]>> = {
  medical: [
    { legacy: 'patientName',  candidates: ['patient_name', 'beneficiary_name', 'person_name', 'holder_name'], seal: true },
    { legacy: 'date',         candidates: ['visit_date', 'report_date', 'vaccination_date', 'admission_date', 'claim_date', 'issue_date'] },
    // doctor_name / hospital_name are isPii:false in the dictionary — a treating
    // professional and a hospital are read there as organisational context.
    { legacy: 'doctorName',   candidates: ['doctor_name', 'referring_doctor'] },
    { legacy: 'hospitalName', candidates: ['hospital_name', 'lab_name', 'vaccination_centre', 'insurer_name'] },
    { legacy: 'details',      candidates: ['notes'], seal: true },
  ],

  vehicles: [
    { legacy: 'vehicleName',      candidates: ['vehicle_make_model'] },
    { legacy: 'vehicleNumber',    candidates: ['registration_number'], seal: true, hash: true, mask: 'tail' },
    { legacy: 'ownerName',        candidates: ['owner_name', 'holder_name'], seal: true },
    { legacy: 'registrationDate', candidates: ['registration_date'] },
    // The taxonomy's vehicle RC carries one `valid_to`; a vehicle record tracks
    // four independent renewals. The extra three are dates, so the open tier is
    // where they belong — they simply have no dictionary key of their own.
    { legacy: 'insuranceExpiry',  candidates: ['insurance_expiry'], reminder: 'Insurance' },
    { legacy: 'pucExpiry',        candidates: ['puc_expiry'],       reminder: 'PUC' },
    { legacy: 'fitnessExpiry',    candidates: ['fitness_expiry'],   reminder: 'Fitness' },
    { legacy: 'lastServiceDate',  candidates: ['last_service_date'] },
    { legacy: 'nextServiceDate',  candidates: ['next_service_date'], reminder: 'Service' },
    { legacy: 'serviceNotes',     candidates: ['notes'], seal: true },
  ],

  lic_mediclaim: [
    { legacy: 'companyName',    candidates: ['insurer_name'] },
    { legacy: 'policyName',     candidates: ['plan_name'] },
    { legacy: 'policyNumber',   candidates: ['policy_number'], seal: true, hash: true, mask: 'tail' },
    { legacy: 'insuredPerson',  candidates: ['holder_name'] },
    { legacy: 'sumAssured',     candidates: ['sum_assured', 'sum_insured', 'idv_amount'], seal: true },
    { legacy: 'premiumAmount',  candidates: ['premium_amount'], seal: true },
    { legacy: 'premiumDueDate', candidates: ['renewal_due_date'], reminder: 'Premium Due' },
    { legacy: 'expiryDate',     candidates: ['maturity_date', 'valid_to'], reminder: 'Policy Expiry' },
  ],

  warranty: [
    { legacy: 'applianceName',   candidates: ['product_name', 'asset_covered'] },
    { legacy: 'company',         candidates: ['brand_name', 'service_provider'] },
    { legacy: 'purchaseDate',    candidates: ['purchase_date', 'valid_from'] },
    { legacy: 'expiryDate',      candidates: ['warranty_expiry', 'valid_to'], reminder: 'Warranty Expiry' },
    { legacy: 'supportContact',  candidates: ['support_contact'], seal: true },
    { legacy: 'notes',           candidates: ['notes'], seal: true },
  ],

  rentals: [
    { legacy: 'title',         candidates: ['document_title'] },
    // A rental's "provider" is a landlord (a person, sealed); a subscription's
    // is a service (an organisation, open). Category-aware candidates give each
    // the right treatment from one mapping.
    { legacy: 'provider',      candidates: ['landlord_name', 'service_name'] },
    { legacy: 'accountNumber', candidates: ['agreement_number', 'subscription_id'], seal: true, hash: true, mask: 'tail' },
    { legacy: 'startDate',     candidates: ['lease_from'] },
    { legacy: 'endDate',       candidates: ['lease_to', 'renewal_due_date'], reminder: 'Contract Ends' },
    { legacy: 'amount',        candidates: ['monthly_rent', 'amount_paid'], seal: true },
    { legacy: 'billingCycle',  candidates: ['billing_cycle'] },
    { legacy: 'notes',         candidates: ['notes'], seal: true },
  ],

  tax_compliance: [
    { legacy: 'title',                 candidates: ['document_title'] },
    { legacy: 'assessmentYear',        candidates: ['assessment_year'] },
    { legacy: 'acknowledgementNumber', candidates: ['acknowledgement_number', 'certificate_number', 'challan_number', 'declaration_number', 'ppo_number', 'arn_number'], seal: true, hash: true, mask: 'tail' },
    { legacy: 'taxableAmount',         candidates: ['taxable_value', 'gross_income', 'total_assets_value'], seal: true },
    { legacy: 'taxPaid',               candidates: ['tax_paid', 'tds_amount', 'amount_paid', 'tax_payable'], seal: true },
    { legacy: 'filingDate',            candidates: ['payment_date', 'issue_date'] },
    { legacy: 'dueDate',               candidates: ['due_date'], reminder: 'Filing Due' },
  ],

  wills_estate: [
    { legacy: 'title',              candidates: ['document_title'] },
    { legacy: 'testatorName',       candidates: ['holder_name'] },
    { legacy: 'executorName',       candidates: ['executor_name', 'attorney_name', 'buyer_name'], seal: true },
    { legacy: 'executionDate',      candidates: ['execution_date'] },
    { legacy: 'registrationStatus', candidates: ['registration_status'] },
    { legacy: 'nominees',           candidates: ['beneficiary_names', 'party_names', 'powers_granted'], seal: true },
  ],

  loans_debt: [
    { legacy: 'title',             candidates: ['document_title'] },
    { legacy: 'lenderName',        candidates: ['lender_name'] },
    { legacy: 'loanAccountNumber', candidates: ['loan_account_number', 'card_last_four'], seal: true, hash: true, mask: 'tail' },
    { legacy: 'principalAmount',   candidates: ['loan_amount', 'sanctioned_amount', 'credit_limit'], seal: true },
    { legacy: 'emiAmount',         candidates: ['emi_amount', 'total_due'], seal: true },
    { legacy: 'interestRate',      candidates: ['interest_rate'] },
    { legacy: 'startDate',         candidates: ['disbursal_date', 'sanction_date'] },
    { legacy: 'maturityDate',      candidates: ['maturity_date'], reminder: 'Loan Maturity' },
    { legacy: 'hasNoc',            candidates: ['has_noc'] },
  ],

  utility_bills: [
    { legacy: 'title',          candidates: ['document_title'] },
    { legacy: 'providerName',   candidates: ['provider_name'] },
    { legacy: 'consumerNumber', candidates: ['consumer_number'], seal: true, hash: true, mask: 'tail' },
    { legacy: 'billingPeriod',  candidates: ['billing_period'] },
    { legacy: 'billAmount',     candidates: ['bill_amount'], seal: true },
    { legacy: 'dueDate',        candidates: ['due_date'], reminder: 'Bill Due' },
    { legacy: 'isPaid',         candidates: ['is_paid'] },
  ],


  employment_payroll: [
    { legacy: 'title',        candidates: ['document_title'] },
    { legacy: 'employerName', candidates: ['employer_name'] },
    { legacy: 'employeeName', candidates: ['employee_name', 'member_name'], seal: true },
    { legacy: 'designation',  candidates: ['designation'] },
    { legacy: 'issueDate',    candidates: ['joining_date', 'issue_date'] },
  ],

  bank_info: [
    { legacy: 'bankName',           candidates: ['bank_name'] },
    { legacy: 'accountNumber',      candidates: ['account_number', 'locker_number', 'card_last_four'], seal: true, hash: true, mask: 'tail' },
    { legacy: 'accountType',        candidates: ['account_type'] },
    { legacy: 'ifscCode',           candidates: ['ifsc_code'], seal: true },
    { legacy: 'branch',             candidates: ['branch_name'] },
    { legacy: 'customerId',         candidates: ['customer_id'], seal: true, hash: true, mask: 'tail' },
    { legacy: 'netBankingUsername', candidates: ['net_banking_username'], seal: true, mask: 'username' },
    // A card belongs to its account, so it stays inside the account's record
    // rather than becoming a sibling row. `cards` is dropped from AI payloads by
    // aiPrivacyMasker's substring rule, which is the behaviour we want.
    { legacy: 'cards',              candidates: ['cards'], seal: true },
    // credit_cards rows fold into this module as record_type='credit_card'.
    { legacy: 'cardName',           candidates: ['document_title'] },
    { legacy: 'cardNetwork',        candidates: ['card_network'] },
    { legacy: 'cardType',           candidates: ['card_type'] },
    { legacy: 'cardHolder',         candidates: ['holder_name'] },
    { legacy: 'cardNumber',         candidates: ['card_number'], seal: true, mask: 'tail' },
    { legacy: 'cardExpiry',         candidates: ['card_expiry'], seal: true },
    { legacy: 'cardCvv',            candidates: ['cvv'], seal: true },
    { legacy: 'lastFour',           candidates: ['card_last_four'], seal: true, hash: true },
  ],

  trading: [
    { legacy: 'brokerName',          candidates: ['broker_name'] },
    { legacy: 'clientId',            candidates: ['client_id'], seal: true, hash: true, mask: 'tail' },
    { legacy: 'dematAccountNumber',  candidates: ['demat_account_number'], seal: true, hash: true, mask: 'tail' },
    { legacy: 'loginUsername',       candidates: ['login_username'], seal: true, mask: 'username' },
    { legacy: 'nomineeName',         candidates: ['nominee_name'], seal: true },
    { legacy: 'details',             candidates: ['notes'], seal: true },
  ],

  investments: [
    { legacy: 'title',                      candidates: ['document_title'] },
    { legacy: 'purchaseDate',               candidates: ['purchase_date', 'registration_date'] },
    { legacy: 'purchaseValue',              candidates: ['principal_amount', 'consideration_amount'], seal: true },
    { legacy: 'currentValue',               candidates: ['current_value', 'maturity_amount'], seal: true },
    { legacy: 'quantity',                   candidates: ['units_held'], seal: true },
    { legacy: 'propertyTaxDueDate',         candidates: ['property_tax_due_date'], reminder: 'Property Tax' },
    // Document-presence flags. Carried forward as-is: the follow-up page renders
    // one "Missing X" card from each. Deriving them from real document records
    // needs a record↔document association the flat model does not yet have.
    { legacy: 'propertyTaxReceiptUploaded', candidates: ['property_tax_receipt_uploaded'] },
    { legacy: 'has712Extract',              candidates: ['has_712_extract'] },
    { legacy: 'hasNamunaD',                 candidates: ['has_namuna_d'] },
    { legacy: 'hasMap',                     candidates: ['has_map'] },
  ],

  documents: [
    // The Document Manager and the bulk scan both ask for ONE number without
    // knowing which of the 83 sub-categories it belongs to, so this is the
    // mapping `identifier` exists for: the candidates below are the categories
    // that happen to share a key name, and every other category answers with
    // its own identifier field instead of misfiling under `document_number`.
    { legacy: 'documentNumber', candidates: ['document_number', 'aadhaar_number', 'pan_number', 'passport_number', 'registration_number', 'certificate_number'], identifier: true, seal: true, hash: true, mask: 'tail' },
    { legacy: 'idHolderName',   candidates: ['holder_name'] },
    { legacy: 'dob',            candidates: ['date_of_birth'], seal: true },
    { legacy: 'fatherName',     candidates: ['father_name'], seal: true },
    { legacy: 'address',        candidates: ['address'], seal: true },
    { legacy: 'expiryDate',     candidates: ['expiry_date', 'valid_to'], reminder: 'Document Expiry' },
    { legacy: 'issueDate',      candidates: ['issue_date'] },
  ],
};

/** Every app module this map covers — the 15 consolidating modules. */
/**
 * The scopes that have a LEGACY wire format — deliberately not every scope.
 *
 * The 14 business scopes are absent. This table translates the camelCase bodies
 * the pre-consolidation pages send; the business modules were built against the
 * generic `/modules` pages and already post snake_case taxonomy keys, so a
 * mapping for them would translate nothing into itself.
 */
export const MAPPED_MODULES = Object.keys(MODULE_FIELD_MAP);

/**
 * The taxonomy key a legacy value should be written under for a given category.
 *
 * In falling order of confidence:
 *
 *  1. For an `identifier` mapping, the category's OWN identifier field — the
 *     one `identifierFields` names. See below for why this outranks the
 *     candidates rather than backing them up.
 *  2. The first CANDIDATE the category declares. Unchanged, and the answer for
 *     every mapping that names a specific fact.
 *  3. `candidates[0]`, so an unmapped-but-harmless key (a date, a boolean flag)
 *     is still normalised to snake_case rather than left camelCase and
 *     inconsistent with its neighbours.
 *
 * ── WHY AN IDENTIFIER MAPPING IGNORES ITS CANDIDATES ───────────────────────
 * `identifier: true` marks the ONE generic field a form asks for when it cannot
 * know the category in advance — the Document Manager's "ID / Document Number",
 * which is a promise about MEANING ("this is what identifies the record") and
 * not about a key name. Its candidate list can only ever hold key names someone
 * thought of, and it failed in both directions:
 *
 *   · Absent. 56 of the 83 categories declare none of the six candidates — a
 *     driving licence is identified by `license_number`, a voter ID by
 *     `voter_id_number` — so the value fell to `document_number`, a key exactly
 *     ONE category declares. It was invisible to the Number column (which reads
 *     `identifierFields`), absent from the duplicate check, and, since the
 *     encrypt list is the category's declared PII fields, left sitting in the
 *     OPEN tier in the clear.
 *   · Present but wrong. `tax_compliance/advance_tax_receipts` declares
 *     `pan_number`, so the candidate matched — but a challan is identified by
 *     its `challan_number`; the PAN is merely quoted on it. The number went
 *     into the taxpayer's PAN field, overwriting a different fact, and the
 *     Number column still showed '-'. Same for 17 other categories.
 *
 * Asking the category what identifies it answers both. It cannot regress the
 * categories the candidates got right, because a key that identifies a category
 * IS its identifier — `identity/pan_card` still resolves to `pan_number`.
 *
 * `specs` is the category's spec as actually loaded at write time — the DB row,
 * which is authoritative and operator-editable. Omitting it falls back to the
 * compiled-in dictionary, which is right for offline callers (tests, seeds) and
 * for a database that has not been seeded.
 */
export function resolveFieldKey(
  mapping: FieldMapping,
  categoryKey: CategoryKey,
  specs?: readonly ResolvableSpec[],
): string {
  const resolved = specs ?? fieldsFor(categoryKey);

  if (mapping.identifier) {
    // The category's first identifier, in its own field order — the same list
    // and the same order `documentDisplay` reads for the Number column, so the
    // key written here is by construction the key that column looks for.
    const [identifier] = identifierFields(resolved);
    if (identifier) return identifier;
  }

  const declared = new Set(resolved.map((f) => f.fieldKey));
  return mapping.candidates.find((c) => declared.has(c)) ?? mapping.candidates[0];
}

/** Index a module's mappings by their legacy key. */
export function mappingsFor(module: string): ReadonlyMap<string, FieldMapping> {
  const list = MODULE_FIELD_MAP[module] ?? [];
  return new Map(list.map((m) => [m.legacy, m]));
}
