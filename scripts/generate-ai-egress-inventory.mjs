#!/usr/bin/env node
/**
 * Generates docs/security/ai-data-egress-inventory.xlsx — a field-level record of
 * everything docsnx transmits to Gemini/OpenAI.
 *
 * The Sent/Dropped verdict is derived at run time from the real forbidden-key list in
 * src/lib/aiPrivacyMasker.ts and the real column list in src/db/schema.ts, so the sheet
 * cannot drift from the code. Everything a parser cannot know (provenance, sensitivity,
 * findings) lives in the curated tables below.
 *
 * Usage: node scripts/generate-ai-egress-inventory.mjs
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import * as XLSX from 'xlsx';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'docs/security/ai-data-egress-inventory.xlsx');

// ─── 1. Read ground truth out of the source ───────────────────────────────────

const maskerSrc = fs.readFileSync(path.join(ROOT, 'src/lib/aiPrivacyMasker.ts'), 'utf8');
const schemaSrc = fs.readFileSync(path.join(ROOT, 'src/db/schema.ts'), 'utf8');

/** The live forbidden-key list, lifted from aiPrivacyMasker.ts rather than retyped. */
function readForbiddenKeys() {
  const block = maskerSrc.match(/const forbiddenKeys = \[([\s\S]*?)\];/);
  if (!block) throw new Error('Could not locate forbiddenKeys in aiPrivacyMasker.ts');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The masker drops a key when its name *contains* a forbidden term (case-insensitive). */
function isDropped(fieldName, forbiddenKeys) {
  return forbiddenKeys.find((f) => fieldName.toLowerCase().includes(f.toLowerCase())) || null;
}

/** Column list for one pgTable, with drizzle type, db column name and trailing comment. */
function readColumns(tableVar) {
  const m = schemaSrc.match(new RegExp(`export const ${tableVar} = pgTable\\(([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`Table ${tableVar} not found in schema.ts`);
  const cols = [];
  for (const line of m[1].split('\n')) {
    const c = line.match(/^\s{2}(\w+):\s*(\w+)\("([^"]+)"/);
    if (!c) continue;
    const comment = line.match(/\/\/\s*(.*)$/);
    cols.push({ field: c[1], type: c[2], dbColumn: c[3], note: comment ? comment[1].trim() : '' });
  }
  return cols;
}

const FORBIDDEN = readForbiddenKeys();
const COMMIT = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  } catch {
    return 'unknown';
  }
})();

// ─── 2. Curated knowledge ─────────────────────────────────────────────────────

/** category param accepted by /api/analysis -> module metadata. */
const MODULES = [
  { cat: 'medical',              aliases: ['medical'],                        table: 'medicalRecords',       label: 'Medical Records',       inUi: true,  scanCat: 'medical' },
  { cat: 'lic_mediclaim',        aliases: ['lic_mediclaim', 'insurance'],     table: 'licMediclaims',        label: 'LIC & Mediclaim',       inUi: true,  scanCat: 'lic_mediclaim' },
  { cat: 'investments',          aliases: ['investments', 'investment'],      table: 'investments',          label: 'Investments',           inUi: true,  scanCat: 'investment' },
  { cat: 'vehicles',             aliases: ['vehicles', 'vehicle'],            table: 'vehicles',             label: 'Vehicles',              inUi: true,  scanCat: 'vehicle' },
  { cat: 'documents',            aliases: ['documents', 'document'],          table: 'documents',            label: 'Documents',             inUi: true,  scanCat: 'document' },
  { cat: 'bank',                 aliases: ['bank', 'banking'],                table: 'bankInfos',            label: 'Bank Info',             inUi: false, scanCat: 'bank' },
  { cat: 'trading',              aliases: ['trading', 'demat'],               table: 'tradingDemats',        label: 'Trading & Demat',       inUi: false, scanCat: 'trading' },
  { cat: 'warranty_amc',         aliases: ['warranty', 'warranty_amc'],       table: 'warrantyAmcs',         label: 'Warranty & AMC',        inUi: false, scanCat: 'warranty_amc' },
  { cat: 'contract_agreement',   aliases: ['contracts', 'contract_agreement'],table: 'contractAgreements',   label: 'Contracts & Rentals',   inUi: false, scanCat: 'contract_agreement' },
  { cat: 'tax_compliance',       aliases: ['tax_compliance', 'tax'],          table: 'taxCompliances',       label: 'Tax & Compliance',      inUi: false, scanCat: 'tax_compliance' },
  { cat: 'will_estate',          aliases: ['will_estate', 'wills_estate'],    table: 'willsEstates',         label: 'Wills & Estate',        inUi: false, scanCat: 'will_estate' },
  { cat: 'loan_debt',            aliases: ['loan_debt', 'loans_debt'],        table: 'loansDebts',           label: 'Loans & Debt',          inUi: false, scanCat: 'loan_debt' },
  { cat: 'utility_bill',         aliases: ['utility_bill', 'utility_bills'],  table: 'utilityBills',         label: 'Utility Bills',         inUi: false, scanCat: 'utility_bill' },
  { cat: 'corporate_compliance', aliases: ['corporate_compliance'],           table: 'corporateCompliances', label: 'Corporate Compliance',  inUi: false, scanCat: 'corporate_compliance' },
  { cat: 'employment_payroll',   aliases: ['employment_payroll'],             table: 'employmentPayrolls',   label: 'Employment & Payroll',  inUi: false, scanCat: 'employment_payroll' },
];

/**
 * Columns written through encryptField() — verified against every write site in src/app/api.
 * These reach the model as AES-GCM ciphertext, never as plaintext.
 */
const ENCRYPTED = new Set([
  'licMediclaims.policyNumber',
  'bankInfos.accountNumber',
  'bankInfos.customerId',
  'bankInfos.netBankingUsername',
  'tradingDemats.clientId',
  'tradingDemats.dematAccountNumber',
  'tradingDemats.loginUsername',
  'loansDebts.accountNumber',
  'utilityBills.consumerNumber',
  'taxCompliances.acknowledgementNumber',
  'corporateCompliances.registrationNumber',
  'contractAgreements.accountNumber',
  'documents.metadata.documentNumber',
]);

/** Fields the bulk-scan prompt asks the model to extract, per scan category (src/lib/ai.js). */
const SCAN_SCHEMA = {
  document: ['name', 'category', 'metadata.documentNumber', 'metadata.idHolderName', 'metadata.dob', 'metadata.fatherName', 'metadata.expiryDate', 'metadata.customFields[]'],
  medical: ['patientName', 'recordType', 'date', 'doctorName', 'hospitalName', 'details'],
  bank: ['bankName', 'accountNumber', 'accountType', 'ifscCode', 'branch', 'customerId', 'netBankingUsername'],
  vehicle: ['vehicleName', 'vehicleNumber', 'ownerName', 'registrationDate', 'insuranceExpiry', 'pucExpiry', 'fitnessExpiry'],
  lic_mediclaim: ['policyType', 'companyName', 'policyName', 'policyNumber', 'insuredPerson', 'sumAssured', 'premiumAmount', 'premiumDueDate', 'expiryDate'],
  investment: ['category', 'title', 'purchaseDate', 'purchaseValue', 'currentValue', 'quantity', 'details'],
  todo: ['task', 'dueDate', 'status'],
  emergency_contact: ['name', 'role', 'phoneNumber', 'email', 'address', 'notes'],
  warranty_amc: ['applianceName', 'company', 'type', 'purchaseDate', 'expiryDate', 'supportContact', 'notes'],
  contract_agreement: ['type', 'name', 'provider', 'accountNumber', 'startDate', 'endDate', 'amount', 'billingCycle', 'notes'],
  tax_compliance: ['formType', 'assessmentYear', 'acknowledgementNumber', 'taxableAmount', 'taxPaid', 'filingDate', 'dueDate'],
  will_estate: ['documentType', 'testatorName', 'executionDate', 'executorName', 'registrationStatus'],
  loan_debt: ['loanType', 'lenderName', 'accountNumber', 'principalAmount', 'emiAmount', 'interestRate', 'startDate', 'maturityDate'],
  utility_bill: ['serviceType', 'providerName', 'consumerNumber', 'billAmount', 'dueDate', 'billingPeriod'],
  corporate_compliance: ['documentType', 'entityName', 'registrationNumber', 'filingDate', 'expiryDate'],
  employment_payroll: ['documentType', 'employerName', 'employeeName', 'designation', 'issueDate'],
  trading: ['brokerName', 'clientId', 'dematAccountNumber', 'loginUsername', 'nomineeName'],
};

/** Credential-grade fields the scan prompt solicits by name — flagged on the schema sheet. */
const CREDENTIAL_GRADE = new Set([
  'netBankingUsername', 'loginUsername', 'accountNumber', 'customerId', 'clientId',
  'dematAccountNumber', 'metadata.documentNumber', 'policyNumber', 'consumerNumber',
  'acknowledgementNumber', 'registrationNumber', 'metadata.dob', 'metadata.fatherName',
]);

/** Per-field sensitivity overrides; anything unlisted falls back to the heuristic below. */
const SENSITIVITY = {
  patientName: 'High (health PII)', doctorName: 'High (health PII)', hospitalName: 'High (health PII)',
  details: 'High (free text, may hold anything)', recordType: 'High (health PII)',
  insuredPerson: 'Medium (named person)', testatorName: 'Medium (named person)',
  executorName: 'Medium (named person)', nomineeName: 'Medium (named person)',
  nominees: 'High (named beneficiaries)', ownerName: 'Medium (named person)',
  employeeName: 'Medium (named person)', employerName: 'Low',
  vehicleNumber: 'High (govt identifier)', ifscCode: 'Medium (bank routing)',
  metadata: 'High (holds govt ID fields)', customFields: 'High (user-defined, uncontrolled)',
  cards: 'Critical (card data)', filePath: 'Medium (storage path)',
  aiAnalysis: 'Low (prior model output)',
};

function sensitivityFor(field, isEncrypted, isHash) {
  if (SENSITIVITY[field]) return SENSITIVITY[field];
  if (isEncrypted) return 'Critical (secret at rest)';
  if (isHash) return 'High (deterministic fingerprint)';
  if (/Number$|Id$|number/i.test(field) && field !== 'fileSize') return 'High (identifier)';
  if (/Amount|Value|Rate|sumAssured|taxPaid|quantity/i.test(field)) return 'Medium (financial)';
  if (/Date|At$|expiry|Expiry/i.test(field)) return 'Low (date)';
  if (/^(id|tenantId|userId|holderId)$/.test(field)) return 'Medium (correlation key)';
  return 'Low';
}

function provenanceFor(field, scanFields) {
  if (field === 'id') return 'DB-generated (uuid defaultRandom)';
  if (field === 'tenantId') return 'Server-set from JWT session';
  if (field === 'userId' || field === 'holderId') return 'Server-set from session / holder picker';
  if (/^(createdAt|updatedAt|deletedAt)$/.test(field)) return 'DB/server timestamp';
  if (/Hash$/.test(field)) return 'Derived server-side (blindIndex HMAC)';
  if (/^(filePath|fileName|mimeType|fileSize)$/.test(field)) return 'Server-computed on upload';
  if (field === 'aiAnalysis') return 'Prior AI output (re-sent to AI)';
  if (field === 'isGlobal') return 'User toggle (share with family)';
  if (scanFields.has(field)) return 'User form input OR AI-extracted from scan';
  return 'User form input';
}

// ─── 3. Sheet builders ────────────────────────────────────────────────────────

function buildFieldInventory() {
  const rows = [];
  for (const mod of MODULES) {
    const scanFields = new Set(SCAN_SCHEMA[mod.scanCat] || []);
    for (const col of readColumns(mod.table)) {
      const key = `${mod.table}.${col.field}`;
      const dropReason = isDropped(col.field, FORBIDDEN);
      const isEnc = ENCRYPTED.has(key);
      const isHash = /Hash$/.test(col.field);
      const isLongText = col.type === 'text' || col.type === 'jsonb';

      let seen;
      if (dropReason) seen = 'Not sent (key dropped)';
      else if (isEnc) seen = 'AES-GCM ciphertext (ivHex:ctHex)';
      else if (isHash) seen = 'HMAC blind index (hex)';
      else if (col.type === 'jsonb') seen = 'Plaintext JSON (recursed + masked)';
      else seen = 'Plaintext';

      const masking = [];
      if (dropReason) masking.push(`Dropped: key contains "${dropReason}"`);
      if (!dropReason && isLongText) masking.push('Truncated at 300 chars if longer');
      if (!dropReason && !isEnc && !isHash) masking.push('Regex mask: Aadhaar/PAN/9-18 digits/email/phone');
      if (isEnc) masking.push('None needed — value is already ciphertext');
      if (isHash) masking.push('None — hash passes through');

      rows.push({
        Module: mod.label,
        Flow: 'CATEGORY_ANALYSIS',
        'API category param': mod.aliases.join(' | '),
        'Exposed in Analysis UI': mod.inUi ? 'Yes' : 'No — API-only, still callable',
        Table: mod.table,
        Field: col.field,
        'DB column': col.dbColumn,
        Type: col.type,
        'How it enters the app': provenanceFor(col.field, scanFields),
        'At-rest state': isEnc ? 'AES-GCM encrypted' : isHash ? 'HMAC blind index' : 'Plaintext',
        'Sent to AI': dropReason ? 'NO' : 'YES',
        'What the AI actually sees': seen,
        'Masking rule applied': masking.join('; '),
        Sensitivity: sensitivityFor(col.field, isEnc, isHash),
        'Code reference': 'src/app/api/analysis/route.ts -> src/lib/ai.js:generateCategoryAnalysis',
      });
    }
  }

  // Nested jsonb keys the column parser cannot see.
  const nested = [
    ['Documents', 'documents', 'metadata.documentNumber', 'Aadhaar / PAN / passport number', 'AI-extracted from scan OR user form input', true],
    ['Documents', 'documents', 'metadata.idHolderName', 'Name printed on the ID', 'AI-extracted from scan OR user form input', false],
    ['Documents', 'documents', 'metadata.dob', 'Date of birth', 'AI-extracted from scan OR user form input', false],
    ['Documents', 'documents', 'metadata.fatherName', "Father's name", 'AI-extracted from scan OR user form input', false],
    ['Documents', 'documents', 'metadata.expiryDate', 'ID expiry date', 'AI-extracted from scan OR user form input', false],
    ['Documents', 'documents', 'metadata.customFields[].label/value', 'Free-form user pairs', 'User form input', false],
    ['Medical Records', 'medicalRecords', 'metadata.*', 'Free-form object (empty on create)', 'Server default {}', false],
    ['Investments', 'investments', 'details.*', 'Per-category detail object', 'User form input OR AI-extracted from scan', false],
    ['Wills & Estate', 'willsEstates', 'nominees[]', 'Beneficiary names/shares', 'User form input', false],
    ['Bank Info', 'bankInfos', 'cards[]', 'Card number / CVV / expiry', 'User form input', false],
    ['All modules', '*', 'customFields[].label/value', 'User-defined key/value pairs', 'User form input', false],
  ];
  for (const [label, table, field, desc, prov, enc] of nested) {
    const dropReason = field.startsWith('cards') ? 'cards' : isDropped(field.split('.').pop(), FORBIDDEN);
    rows.push({
      Module: label,
      Flow: 'CATEGORY_ANALYSIS (nested jsonb)',
      'API category param': '(inside parent jsonb column)',
      'Exposed in Analysis UI': '',
      Table: table,
      Field: field,
      'DB column': '(nested)',
      Type: 'jsonb key',
      'How it enters the app': prov,
      'At-rest state': enc ? 'AES-GCM encrypted' : 'Plaintext',
      'Sent to AI': dropReason ? 'NO' : 'YES',
      'What the AI actually sees': dropReason
        ? 'Not sent (key dropped)'
        : enc ? 'AES-GCM ciphertext (ivHex:ctHex)' : 'Plaintext (regex-masked)',
      'Masking rule applied': dropReason
        ? `Dropped: key contains "${dropReason}"`
        : 'cleanObject() recurses into nested objects/arrays; regex mask + 300-char truncation',
      Sensitivity: enc ? 'Critical (secret at rest)' : desc.includes('CVV') ? 'Critical' : 'High',
      'Code reference': 'src/lib/aiPrivacyMasker.ts:cleanObject',
    });
  }

  // RECORD_ANALYSIS — the two hand-built objects.
  const recordAnalysis = [
    ['Investments', 'investments', ['category', 'title', 'purchaseDate', 'purchaseValue', 'currentValue', 'quantity', 'details'],
      'src/app/api/investments/route.ts:76 & [id]/route.ts:92 -> generateRecordAnalysis'],
    ['LIC & Mediclaim', 'licMediclaims', ['policyType', 'companyName', 'policyName', 'sumAssured', 'premiumAmount', 'premiumDueDate', 'expiryDate'],
      'src/app/api/lic-mediclaim/route.ts:96 & [id]/route.ts:161 -> generateRecordAnalysis'],
  ];
  for (const [label, table, fields, ref] of recordAnalysis) {
    for (const f of fields) {
      rows.push({
        Module: label,
        Flow: 'RECORD_ANALYSIS',
        'API category param': 'n/a (fires on create/update)',
        'Exposed in Analysis UI': 'n/a',
        Table: table,
        Field: f,
        'DB column': '(pre-insert value, not read back from DB)',
        Type: 'request value',
        'How it enters the app': 'User form input OR AI-extracted from scan',
        'At-rest state': 'Plaintext at this point (encryption happens after the AI call)',
        'Sent to AI': 'YES',
        'What the AI actually sees': f === 'details' ? 'Plaintext JSON (recursed + masked)' : 'Plaintext',
        'Masking rule applied': 'prepareAiPayload: regex mask + 300-char truncation',
        Sensitivity: sensitivityFor(f, false, false),
        'Code reference': ref,
      });
    }
    rows.push({
      Module: label,
      Flow: 'RECORD_ANALYSIS',
      'API category param': 'n/a',
      'Exposed in Analysis UI': 'n/a',
      Table: table,
      Field: '(all other columns)',
      'DB column': '—',
      Type: '—',
      'How it enters the app': '—',
      'At-rest state': '—',
      'Sent to AI': 'NO',
      'What the AI actually sees': 'Not sent — object is built field-by-field, not read from the row',
      'Masking rule applied': 'n/a',
      Sensitivity: '—',
      'Code reference': ref,
    });
  }

  return rows;
}

function buildEntryPoints() {
  const scanPages = [
    'documents', 'medical', 'vehicles', 'trading', 'tax-compliance', 'lic-mediclaim',
    'utility-bills', 'employment-payroll', 'loans-debt', 'wills-estate', 'warranty',
    'todos', 'rentals', 'important-contacts', 'corporate-compliance', 'dashboard/bulk-scan',
  ];
  const rows = scanPages.map((p) => ({
    'UI entry point': `src/app/${p}/page.js`,
    'Fetch URL': 'POST /api/ai/scan',
    'Route handler': 'src/app/api/ai/scan/route.js',
    'Lib function': 'src/lib/ai.js:scanMultipleFiles',
    'Op label': 'BULK_SCAN',
    Provider: 'Gemini (default) or OpenAI, per tenant key rotation',
    'Auth gate': "getUserFromRequest + hasPermission('documents','add')",
    'Masking applied': 'maskSensitiveText on text parts only — image/PDF bytes are NOT masked',
  }));

  rows.push({
    'UI entry point': 'src/app/analysis/page.js:42',
    'Fetch URL': 'GET /api/analysis?category=<cat>[&refresh=true]',
    'Route handler': 'src/app/api/analysis/route.ts',
    'Lib function': 'src/lib/ai.js:generateCategoryAnalysis',
    'Op label': 'CATEGORY_ANALYSIS',
    Provider: 'Gemini / OpenAI via executeTenantWithRotation',
    'Auth gate': 'getUserFromRequest; SUPER_ADMIN forbidden. No hasPermission() check.',
    'Masking applied': 'prepareAiPayload on the full result set',
  });
  rows.push({
    'UI entry point': 'src/app/investments/page.js (create/update)',
    'Fetch URL': 'POST/PUT /api/investments',
    'Route handler': 'src/app/api/investments/route.ts:87, [id]/route.ts:100',
    'Lib function': 'src/lib/ai.js:generateRecordAnalysis',
    'Op label': 'RECORD_ANALYSIS',
    Provider: 'Gemini / OpenAI via executeTenantWithRotation',
    'Auth gate': 'getUserFromRequest + hasPermission',
    'Masking applied': 'prepareAiPayload on a 7-field object',
  });
  rows.push({
    'UI entry point': 'src/app/lic-mediclaim/page.js (create/update)',
    'Fetch URL': 'POST/PUT /api/lic-mediclaim',
    'Route handler': 'src/app/api/lic-mediclaim/route.ts:105, [id]/route.ts:171',
    'Lib function': 'src/lib/ai.js:generateRecordAnalysis',
    'Op label': 'RECORD_ANALYSIS',
    Provider: 'Gemini / OpenAI via executeTenantWithRotation',
    'Auth gate': 'getUserFromRequest + hasPermission',
    'Masking applied': 'prepareAiPayload on a 7-field object (policyNumber & insuredPerson excluded)',
  });
  rows.push({
    'UI entry point': 'src/app/admin/ai-settings/page.js',
    'Fetch URL': 'PUT /api/context',
    'Route handler': 'src/app/api/context/route.ts:94',
    'Lib function': 'src/lib/context-manager.mjs:optimizeContextWithAI',
    'Op label': '(none — bypasses aiKeyManager)',
    Provider: 'Gemini 2.5 Flash via process.env.GEMINI_API_KEY directly',
    'Auth gate': 'SUPER_ADMIN only',
    'Masking applied': 'NONE. Sends AI_CONTEXT.md: project metadata, DB schema, dir tree, git info. No tenant records.',
  });
  rows.push({
    'UI entry point': '(no caller — dead code)',
    'Fetch URL': '—',
    'Route handler': '—',
    'Lib function': 'src/lib/ai.js:generatePortfolioAnalysis',
    'Op label': 'PORTFOLIO_ANALYSIS',
    Provider: '—',
    'Auth gate': '—',
    'Masking applied': 'prepareAiPayload (never reached)',
  });
  return rows;
}

function buildIdentifiers() {
  const ids = [
    ['All 15 modules', 'id', 'Row UUID', 'DB-generated', 'Plaintext UUID', 'YES', 'Not personal data, but a stable per-record correlator held by the provider.'],
    ['All 15 modules', 'tenantId', 'Tenant UUID', 'Server-set from JWT', 'Plaintext UUID', 'YES', 'Lets the provider group every record belonging to one family/tenant.'],
    ['All 15 modules', 'userId / holderId', 'User UUIDs', 'Server-set', 'Plaintext UUID', 'YES', 'Links records to a specific family member.'],
    ['Documents', 'metadata.documentNumber', 'Aadhaar / PAN / passport / DL number', 'User input or scan extraction', 'AES-GCM ciphertext', 'YES (as ciphertext)', 'Encrypted by encryptDocMetadata before insert; the model receives an opaque blob.'],
    ['Bank Info', 'accountNumber', 'Bank account number', 'User input or scan extraction', 'AES-GCM ciphertext', 'YES (as ciphertext)', 'Plaintext never reaches the model via /api/analysis.'],
    ['Bank Info', 'accountNumberHash', 'Blind index of the account number', 'Derived (HMAC)', 'HMAC hex', 'YES', 'Deterministic fingerprint — same account always yields the same hash.'],
    ['Bank Info', 'customerId', 'Bank customer ID', 'User input', 'AES-GCM ciphertext', 'YES (as ciphertext)', ''],
    ['Bank Info', 'ifscCode', 'Bank branch routing code', 'User input', 'Plaintext', 'YES', 'Not encrypted; identifies the branch.'],
    ['Bank Info', 'netBankingUsername', 'Net-banking login', 'User input', 'AES-GCM ciphertext', 'NO', 'Key dropped by the privacy shield.'],
    ['Bank Info', 'cards[]', 'Card number / CVV / expiry', 'User input', 'Encrypted jsonb', 'NO', 'Key dropped by the privacy shield.'],
    ['Trading & Demat', 'clientId', 'Broker client ID', 'User input or scan extraction', 'AES-GCM ciphertext', 'YES (as ciphertext)', ''],
    ['Trading & Demat', 'dematAccountNumber', 'Demat account number', 'User input or scan extraction', 'AES-GCM ciphertext', 'YES (as ciphertext)', ''],
    ['Trading & Demat', 'clientIdHash / dematAccountNumberHash', 'Blind indexes', 'Derived (HMAC)', 'HMAC hex', 'YES', 'Deterministic fingerprints.'],
    ['Trading & Demat', 'loginUsername', 'Broker portal login', 'User input', 'AES-GCM ciphertext', 'NO', 'Key dropped by the privacy shield.'],
    ['LIC & Mediclaim', 'policyNumber', 'Insurance policy number', 'User input or scan extraction', 'AES-GCM ciphertext', 'YES (as ciphertext)', 'Excluded entirely from RECORD_ANALYSIS.'],
    ['LIC & Mediclaim', 'policyNumberHash', 'Blind index', 'Derived (HMAC)', 'HMAC hex', 'YES', ''],
    ['Loans & Debt', 'accountNumber / accountNumberHash', 'Loan account number + index', 'User input or scan extraction', 'Ciphertext / HMAC', 'YES (ciphertext + hash)', ''],
    ['Utility Bills', 'consumerNumber / consumerNumberHash', 'Consumer number + index', 'User input or scan extraction', 'Ciphertext / HMAC', 'YES (ciphertext + hash)', ''],
    ['Tax & Compliance', 'acknowledgementNumber', 'ITR/GST acknowledgement', 'User input or scan extraction', 'AES-GCM ciphertext', 'YES (as ciphertext)', ''],
    ['Corporate Compliance', 'registrationNumber', 'CIN / registration number', 'User input or scan extraction', 'AES-GCM ciphertext', 'YES (as ciphertext)', ''],
    ['Contracts & Rentals', 'accountNumber', 'Provider account number', 'User input or scan extraction', 'AES-GCM ciphertext', 'YES (as ciphertext)', 'Written encrypted by the rentals route.'],
    ['Vehicles', 'vehicleNumber', 'Registration plate', 'User input or scan extraction', 'Plaintext', 'YES', 'Not encrypted and not covered by any mask pattern.'],
    ['All modules', 'filePath', 'Storage path / Drive file reference', 'Server-computed', 'Plaintext', 'YES', 'Reveals filenames and storage layout.'],
    ['BULK_SCAN (all modules)', 'Every identifier printed on the document', 'Aadhaar, PAN, account, policy numbers', 'Raw upload', 'Image bytes', 'YES — fully legible', 'Scan sends 150-dpi JPEG page images; no masking is possible on pixels.'],
  ];
  return ids.map(([module, field, what, prov, atRest, sent, note]) => ({
    Module: module, Field: field, 'What it is': what, 'How it enters the app': prov,
    'At-rest state': atRest, 'Sent to AI': sent, Notes: note,
  }));
}

function buildScanPayload() {
  return [
    { 'Input type': 'PDF', 'Processing': 'pdftoppm -jpeg -jpegopt quality=85 -r 150 → one JPEG per page', 'What is transmitted': 'base64 inlineData image part per page', 'Masked?': 'NO — pixels cannot be masked', 'Code reference': 'src/lib/documentProcessor.ts:57-100' },
    { 'Input type': 'Images (jpg/png/…)', 'Processing': 'Compressed via sharp', 'What is transmitted': 'base64 inlineData image part', 'Masked?': 'NO', 'Code reference': 'src/lib/documentProcessor.ts' },
    { 'Input type': 'doc / docx', 'Processing': 'mammoth.extractRawText', 'What is transmitted': 'Extracted text, prefixed with [File Index i: "name" (mime)]', 'Masked?': 'YES — maskSensitiveText', 'Code reference': 'src/lib/documentProcessor.ts:161' },
    { 'Input type': 'xls / xlsx', 'Processing': 'xlsx → sheet_to_csv per sheet', 'What is transmitted': 'CSV text of every sheet', 'Masked?': 'YES — maskSensitiveText', 'Code reference': 'src/lib/documentProcessor.ts:167-172' },
    { 'Input type': 'txt / csv', 'Processing': 'utf-8 read', 'What is transmitted': 'Raw text', 'Masked?': 'YES — maskSensitiveText', 'Code reference': 'src/lib/documentProcessor.ts:174' },
    { 'Input type': 'File manifest', 'Processing': 'Built per request', 'What is transmitted': 'Index, filename, mimeType, contentType for every file', 'Masked?': 'YES (string part)', 'Code reference': 'src/lib/ai.js:281' },
    { 'Input type': 'System prompt', 'Processing': 'Static', 'What is transmitted': 'Category taxonomy + extraction schema (no user data)', 'Masked?': 'n/a', 'Code reference': 'src/lib/ai.js:204-265' },
    { 'Input type': 'Token pre-count', 'Processing': 'client.models.countTokens', 'What is transmitted': 'The entire payload, a second time', 'Masked?': 'Same as above', 'Code reference': 'src/lib/ai.js:89' },
    { 'Input type': 'Context cache (≥32,768 tokens)', 'Processing': 'client.caches.create ttl=3600s', 'What is transmitted': 'Payload stored on Google infra until deleted in finally block', 'Masked?': 'Same as above', 'Code reference': 'src/lib/ai.js:103-123' },
  ];
}

function buildScanExtractionSchema() {
  const rows = [];
  for (const [cat, fields] of Object.entries(SCAN_SCHEMA)) {
    for (const f of fields) {
      rows.push({
        'Scan category': cat,
        'Requested field': f,
        'Credential-grade?': CREDENTIAL_GRADE.has(f) ? 'YES — prompt explicitly asks for it' : '',
        'Stored where': cat === 'todo' ? 'todos' : cat === 'emergency_contact' ? 'emergencyContacts'
          : (MODULES.find((m) => m.scanCat === cat)?.table || '—'),
        'Code reference': 'src/lib/ai.js:240-256 (prompt schema); src/app/api/ai/scan/save/route.ts (persistence)',
      });
    }
  }
  return rows;
}

function buildNeverSent() {
  return [
    ['Passwords vault', 'passwords', 'No AI code path reads this table.'],
    ['Credit cards', 'creditCards', 'No AI code path; card data also dropped by the shield if ever nested.'],
    ['Important contacts', 'emergencyContacts', 'Can be CREATED by bulk scan, but stored rows are never sent to AI.'],
    ['To-dos', 'todos', 'Can be created by bulk scan; no analysis category exists.'],
    ['Rentals (as a UI module)', 'contractAgreements', 'Rows ARE sent via category=contracts; the rentals UI itself has no AI read path.'],
    ['Profiles', 'profiles', 'Auto-updated from records; never transmitted.'],
    ['Users', 'users', 'passwordHash never leaves the DB.'],
    ['Tenants', 'tenants', 'Tenant AI keys are encrypted; never in a prompt.'],
    ['Billing / payments / invoices', 'payments, invoices, plans, addons', 'No AI path.'],
    ['Audit logs', 'auditLogs', 'No AI path.'],
    ['Notifications', 'notifications', 'No AI path.'],
  ].map(([module, table, note]) => ({ Module: module, Table: table, Notes: note }));
}

function buildFindings() {
  return [
    ['High', 'Bulk scan transmits fully legible document images', 'Every Aadhaar, PAN, passport, bank statement and salary slip page is sent as a 150-dpi JPEG. The privacy shield only touches string parts, so nothing about the image is masked.', 'src/lib/ai.js:271-279', 'Accept as inherent to OCR, or add server-side redaction / an explicit per-upload consent gate.'],
    ['High', 'Category analysis sends whole DB rows', 'findMany() with no column projection ships id, tenantId, userId, holderId, filePath, aiAnalysis and every *Hash to the provider. None of it contributes to the analysis.', 'src/app/api/analysis/route.ts:65-97', 'Add a per-category column allowlist before calling generateCategoryAnalysis.'],
    ['Medium', 'Blind-index hashes are transmitted', 'accountNumberHash, policyNumberHash, clientIdHash, dematAccountNumberHash, consumerNumberHash are deterministic fingerprints of secret values; identical inputs always produce identical hashes.', 'src/db/schema.ts', 'Strip *Hash columns in the allowlist above.'],
    ['Medium', '10 of 15 analysis categories are not in the UI but remain callable', 'The Analysis page exposes 5 categories; bank, trading, loans, tax, wills, utility, corporate, employment, warranty and contracts are reachable by any authenticated non-SUPER_ADMIN via a direct GET.', 'src/app/analysis/page.js:22 vs src/app/api/analysis/route.ts:65', 'Either expose them deliberately or gate them behind hasPermission(module, "view").'],
    ['Medium', 'Encrypted columns are sent as ciphertext', 'No plaintext leaks, but the model receives opaque blobs it cannot use, inflating token cost and prompt noise on 11 fields.', 'src/lib/fieldCrypto.ts + analysis route', 'Exclude encrypted columns from the AI payload entirely.'],
    ['Medium', 'optimizeContextWithAI bypasses aiKeyManager', 'Calls Gemini directly with process.env.GEMINI_API_KEY — no rotation, no quota accounting, no tenant cost attribution. Violates AGENTS.md §8.', 'src/lib/context-manager.mjs:304-326', 'Route through executeWithRotation().'],
    ['Low', 'Forbidden-key matching is substring-based', 'key.toLowerCase().includes(f) means "pin" matches any key containing it (e.g. shipping-style names) while a differently-named credential column would pass straight through.', 'src/lib/aiPrivacyMasker.ts:77', 'Switch to exact match plus an explicit regex list.'],
    ['Low', 'Payload is transmitted twice on the Gemini path', 'countTokens() sends the full payload before generateContent() sends it again.', 'src/lib/ai.js:89', 'Estimate tokens locally, or accept the double send.'],
    ['Low', 'Large payloads are cached on Google infrastructure', 'Payloads ≥32,768 tokens are written to a context cache with ttl 3600s; deleted in a finally block, but resident until then.', 'src/lib/ai.js:103-123', 'Document in the privacy policy / DPIA.'],
    ['Info', 'generatePortfolioAnalysis is dead code', 'No caller anywhere in src/. Same for getMockPortfolioAnalysis.', 'src/lib/ai.js:374, 446', 'Delete, or wire up the dashboard feature it was written for.'],
  ].map(([sev, finding, detail, ref, fix]) => ({
    Severity: sev, Finding: finding, Detail: detail, 'Code reference': ref, 'Suggested fix': fix,
  }));
}

function buildReadme() {
  return [
    ['Document', 'docsnx — AI data egress inventory'],
    ['Generated', new Date().toISOString()],
    ['Source commit', COMMIT],
    ['Regenerate with', 'node scripts/generate-ai-egress-inventory.mjs'],
    ['Scope', 'Every field transmitted to Gemini/OpenAI by docsnx, as of the commit above.'],
    ['', ''],
    ['How this is derived', 'Column lists are parsed from src/db/schema.ts and the Sent/Dropped verdict is computed with the live forbidden-key list read out of src/lib/aiPrivacyMasker.ts. Provenance, sensitivity and findings are curated in the script.'],
    ['', ''],
    ['Sheet: Entry_Points', 'Every UI action that results in an outbound AI call.'],
    ['Sheet: Field_Inventory', 'One row per field per flow — the main sheet. Filterable.'],
    ['Sheet: Identifiers_Focus', 'IDs, document numbers and identity numbers, and exactly what the provider sees for each.'],
    ['Sheet: Scan_Payload', 'What POST /api/ai/scan puts on the wire.'],
    ['Sheet: Scan_Extraction_Schema', 'The 17 category schemas the scan prompt asks the model to return.'],
    ['Sheet: Never_Sent', 'Modules with no AI read path at all.'],
    ['Sheet: Findings', 'Ranked gaps with suggested fixes.'],
    ['', ''],
    ['LEGEND — Sent to AI', 'YES = transmitted. NO = removed by the privacy shield before transmission.'],
    ['LEGEND — Plaintext', 'The real value, readable by the provider (after regex masking of Aadhaar/PAN/long digit runs/emails/phones).'],
    ['LEGEND — AES-GCM ciphertext', 'Encrypted at rest via src/lib/fieldCrypto.ts; the provider receives ivHex:ctHex and cannot read it.'],
    ['LEGEND — HMAC blind index', 'Deterministic hash used for lookup. Not reversible, but the same input always yields the same value.'],
    ['LEGEND — Not sent (key dropped)', 'Field name matched the forbidden-key list in prepareAiPayload().'],
    ['LEGEND — Truncated at 300 chars', 'Strings longer than 300 characters are cut for token optimisation.'],
    ['', ''],
    ['Masking caveat', 'maskSensitiveText only applies to strings. Image and PDF page bytes sent by bulk scan are transmitted unmodified.'],
    ['Forbidden keys (live)', FORBIDDEN.join(', ')],
  ].map(([k, v]) => ({ Item: k, Detail: v }));
}

// ─── 4. Emit ──────────────────────────────────────────────────────────────────

function addSheet(wb, name, rows, widths) {
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = widths.map((w) => ({ wch: w }));
  const range = XLSX.utils.decode_range(ws['!ref']);
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: range.e.r, c: range.e.c } }) };
  XLSX.utils.book_append_sheet(wb, ws, name);
  return rows.length;
}

const wb = XLSX.utils.book_new();
const fieldRows = buildFieldInventory();

addSheet(wb, 'README', buildReadme(), [26, 120]);
addSheet(wb, 'Entry_Points', buildEntryPoints(), [40, 46, 44, 40, 20, 42, 46, 70]);
addSheet(wb, 'Field_Inventory', fieldRows, [24, 28, 30, 30, 22, 30, 28, 12, 42, 30, 12, 38, 56, 34, 62]);
addSheet(wb, 'Identifiers_Focus', buildIdentifiers(), [26, 38, 36, 40, 30, 22, 80]);
addSheet(wb, 'Scan_Payload', buildScanPayload(), [26, 46, 58, 34, 44]);
addSheet(wb, 'Scan_Extraction_Schema', buildScanExtractionSchema(), [24, 34, 34, 24, 66]);
addSheet(wb, 'Never_Sent', buildNeverSent(), [30, 34, 72]);
addSheet(wb, 'Findings', buildFindings(), [10, 58, 96, 46, 62]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
XLSX.writeFile(wb, OUT);

const dropped = fieldRows.filter((r) => r['What the AI actually sees'] === 'Not sent (key dropped)');
const cipher = fieldRows.filter((r) => r['What the AI actually sees'].startsWith('AES-GCM'));
const hashes = fieldRows.filter((r) => r['What the AI actually sees'].startsWith('HMAC'));

console.log(`Wrote ${path.relative(ROOT, OUT)} @ ${COMMIT}`);
console.log(`  Field_Inventory rows : ${fieldRows.length}`);
console.log(`  dropped by shield    : ${dropped.length} (${dropped.map((r) => `${r.Table}.${r.Field}`).join(', ')})`);
console.log(`  sent as ciphertext   : ${cipher.length}`);
console.log(`  sent as blind index  : ${hashes.length}`);
