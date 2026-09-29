import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DOCUMENT_CATEGORY_FIELD_SEED,
  DOCUMENT_CATEGORY_ENCRYPTED_FIELDS,
  DOCUMENT_CATEGORY_FIELD_LISTS,
  DOCUMENT_CATEGORY_FIELD_SPECS,
  FIELD_DATA_TYPES,
  parseEncryptedFields,
  parseFieldCsv,
  encryptedFieldsFor,
  fieldsFor,
  allFieldKeysFor,
  mandatoryFieldsFor,
  ocrFieldKeys,
  ocrFieldsFor,
  NEVER_PRINTED_KEYS,
} from '../src/lib/documentCategoryFields';
import {
  DOCUMENT_CATEGORY_SEED,
  UNCATEGORIZED,
  categoryLabel as label,
  isBusinessModule,
} from '../src/lib/documentCategories';
import { prepareAiPayload, maskSensitiveText } from '../src/lib/aiPrivacyMasker';
import { splitRecordFields } from '../src/lib/vault/fieldSplitter';

/**
 * Guards the document field dictionary (src/lib/documentCategoryFields.ts) —
 * the policy that decides which extracted fields get sealed under the vault key
 * and which land in the open, AI-readable tier. Pure — no DB, no network.
 *
 * Two tests here are load-bearing rather than cosmetic:
 *   • full coverage — an unclassified field FAILS OPEN, so a category with no
 *     rows silently sends everything to the AI tier;
 *   • the masker round-trip — an open-tier key whose name trips
 *     prepareAiPayload's forbidden-substring check is deleted from the payload,
 *     so the field would appear classified while reaching nothing.
 */

/**
 * The migration that currently STATES the policy, not the one that first created
 * the table. 0008 built the CSV shape; 0014 re-stated all 83 rows when
 * holder_name moved to the open tier and the bank/trading/card credential keys
 * were added; 0015 re-stated them again under the reshuffled module names.
 * Parity must track the newest statement or it asserts history.
 */
const MIGRATION_PATH = join(
  __dirname, '..', 'drizzle', '0015_taxonomy_reshuffle.sql',
);
/** 0018 re-stated the 15 miscellaneous policies as the module-wide union. */
const MISC_MIGRATION_PATH = join(
  __dirname, '..', 'drizzle', '0018_miscellaneous_policy_union.sql',
);
/** 0008 still owns the structural assertions — it is what reshaped the table. */
const STRUCTURE_MIGRATION_PATH = join(
  __dirname, '..', 'drizzle', '0008_document_category_fields_csv.sql',
);
const structureSql = readFileSync(STRUCTURE_MIGRATION_PATH, 'utf8');

/**
 * 0035 dropped the policy rows of the 15 categories 0023 retired, restoring the
 * one-row-per-ACTIVE-category invariant the table had lost.
 */
const DROP_RETIRED_PATH = join(
  __dirname, '..', 'drizzle', '0035_drop_retired_category_policies.sql',
);
const dropRetiredSql = readFileSync(DROP_RETIRED_PATH, 'utf8');

/**
 * 0023 moved the taxonomy onto the master document table. It re-keyed the MODULE
 * half of every category and left `document_category_fields` alone, because that
 * table joins on `category_id` and no `document_key` moved.
 *
 * So parity against 0015/0018 — which state their rows under the OLD module
 * names — has to be read through 0023's own mapping. Built from the migration
 * rather than hard-coded here, so the two cannot drift.
 */
const REKEY_PATH = join(__dirname, '..', 'drizzle', '0023_master_taxonomy_realignment.sql');
const rekeySql = readFileSync(REKEY_PATH, 'utf8');
const REKEY = new Map<string, { moduleKey: string; documentKey: string; retired: boolean }>(
  Array.from(rekeySql.matchAll(
    /^ {2}\('([a-z0-9_]+)','([a-z0-9_]+)',\s*\d+,'([a-z0-9_]+)','[^']*','([a-z0-9_]+)',\s*\d+,(true|false)\)/gm,
  )).map((m) => [
    `${m[1]}/${m[2]}`,
    { moduleKey: m[3], documentKey: m[4], retired: m[5] === 'true' },
  ]),
);

/** The (module, document) pair an OLD pair became, or null if 0023 retired it. */
function rekeyed(oldModuleKey: string, oldDocumentKey: string) {
  const hit = REKEY.get(`${oldModuleKey}/${oldDocumentKey}`);
  if (!hit || hit.retired) return null;
  return `${hit.moduleKey}.${hit.documentKey}`;
}

describe('Document category field dictionary', () => {
  describe('Coverage', () => {
    it('classifies at least one field for every seeded category', () => {
      const covered = new Set(DOCUMENT_CATEGORY_FIELD_SEED.map(label));
      for (const cat of DOCUMENT_CATEGORY_SEED) {
        expect(covered.has(label(cat)), `${label(cat)} has no field policy — it FAILS OPEN`)
          .toBe(true);
      }
      expect(covered.size).toBe(DOCUMENT_CATEGORY_SEED.length);
    });

    it('references no category outside the taxonomy', () => {
      const known = new Set(DOCUMENT_CATEGORY_SEED.map(label));
      for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
        expect(known.has(label(row)), `unknown category ${label(row)}`).toBe(true);
      }
    });

    it('gives every category the baseline fields', () => {
      const byCategory = new Map<string, Set<string>>();
      for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
        if (!byCategory.has(label(row))) byCategory.set(label(row), new Set());
        byCategory.get(label(row))!.add(row.fieldKey);
      }
      for (const [code, keys] of byCategory) {
        for (const baseline of ['document_title', 'holder_name', 'issue_date', 'notes']) {
          expect(keys.has(baseline), `${code} is missing baseline field ${baseline}`).toBe(true);
        }
      }
    });

    it('gives the one catch-all the UNION of every other category', () => {
      // Inverted by 0023, deliberately. The fallback bucket used to carry only
      // the baseline, which was safe when it meant "unclassified DOCUMENT" and a
      // sibling `<module>/miscellaneous` held the union for each module. Now it
      // is the only catch-all there is, and it receives records whose MODULE was
      // not identified — the moment we know least. A baseline-only policy would
      // write an unclassified bank record's account number in the clear.
      const catchAll = DOCUMENT_CATEGORY_FIELD_SEED
        .filter((r) => r.moduleKey === UNCATEGORIZED.moduleKey
          && r.documentKey === UNCATEGORIZED.documentKey)
        .map((r) => r.fieldKey);
      const everyField = new Set(DOCUMENT_CATEGORY_FIELD_SEED.map((r) => r.fieldKey));
      expect([...everyField].filter((f) => !catchAll.includes(f)),
        'the catch-all does not cover these').toEqual([]);
      // The baseline is still in there, in its usual place.
      for (const baseline of ['document_title', 'holder_name', 'issue_date', 'notes']) {
        expect(catchAll).toContain(baseline);
      }
    });
  });

  describe('Row shape', () => {
    it('uses snake_case field keys', () => {
      for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
        expect(row.fieldKey, `${row.fieldKey} is not snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    });

    it('has a unique field key per category', () => {
      const seen = new Set<string>();
      for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
        const composite = `${label(row)}|${row.fieldKey}`;
        expect(seen.has(composite), `duplicate ${composite}`).toBe(false);
        seen.add(composite);
      }
    });

    it('uses only the six data types the column accepts', () => {
      for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
        expect(FIELD_DATA_TYPES, `${row.fieldKey} has data type ${row.dataType}`)
          .toContain(row.dataType);
      }
    });

    it('fits the column widths (field_key 100, field_label 200)', () => {
      for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
        expect(row.fieldKey.length).toBeLessThanOrEqual(100);
        expect(row.fieldLabel.length).toBeLessThanOrEqual(200);
      }
    });

    it('numbers sortOrder from 10 upwards within each category', () => {
      const byCategory = new Map<string, number[]>();
      for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
        if (!byCategory.has(label(row))) byCategory.set(label(row), []);
        byCategory.get(label(row))!.push(row.sortOrder);
      }
      for (const [code, orders] of byCategory) {
        expect(orders, `${code} sortOrder is not 10,20,30…`).toEqual(
          orders.map((_, i) => (i + 1) * 10),
        );
      }
    });
  });

  describe('PII classification', () => {
    it('seals every key that names an identifier, a name, an amount or free text', () => {
      // A spot-check of the shapes that must never reach the open tier. Not
      // exhaustive — the substring rule below is the general guard.
      const mustBeSealed = [
        'aadhaar_number', 'pan_number', 'passport_number', 'account_number',
        'policy_number', 'date_of_birth', 'address', 'notes',
        'gstin', 'uan_number', 'ifsc_code', 'diagnosis', 'gross_salary',
        // Credential-grade keys added when bank/trading/cards joined the vault.
        'customer_id', 'net_banking_username', 'cards', 'client_id',
        'login_username', 'card_number', 'card_expiry', 'cvv',
        'support_contact', 'taxable_value', 'tax_paid',
      ];
      for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
        if (mustBeSealed.includes(row.fieldKey)) {
          expect(row.isPii, `${label(row)}.${row.fieldKey} is in the OPEN tier`).toBe(true);
        }
      }
    });

    it('keeps holder_name OPEN, and only holder_name among the name fields', () => {
      // Deliberate, and the one exception to "a person's name is PII": the
      // holder is a member whose name is already plaintext in
      // `users.name`, reachable from `documents.holder_id`. Sealing it protected
      // nothing and cost every list view its label. Third-party names stay
      // sealed — that distinction is the whole rule, so it is asserted here.
      const holderRows = DOCUMENT_CATEGORY_FIELD_SEED.filter((r) => r.fieldKey === 'holder_name');
      expect(holderRows.length).toBeGreaterThan(0);
      for (const row of holderRows) {
        expect(row.isPii, `${label(row)}.holder_name should be open`).toBe(false);
      }

      for (const key of ['executor_name', 'nominee_name', 'father_name', 'seller_name', 'buyer_name']) {
        for (const row of DOCUMENT_CATEGORY_FIELD_SEED.filter((r) => r.fieldKey === key)) {
          expect(row.isPii, `${label(row)}.${key} is a third party and must stay sealed`).toBe(true);
        }
      }
    });

    it('classifies a field key consistently across every category', () => {
      // The same key meaning "sealed" here and "open" there would make the
      // splitter's behaviour depend on which category a document landed in.
      const byKey = new Map<string, boolean>();
      for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
        if (byKey.has(row.fieldKey)) {
          expect(byKey.get(row.fieldKey), `${row.fieldKey} is classified both ways`)
            .toBe(row.isPii);
        }
        byKey.set(row.fieldKey, row.isPii);
      }
    });

    it('keeps every open-tier key out of prepareAiPayload s forbidden list', () => {
      // prepareAiPayload drops a key whose lowercased name CONTAINS a forbidden
      // word — substring, not equality, so 'shipping_date' would be eaten by
      // 'pin'. A key that disappears here is worse than a sealed one: it looks
      // classified and delivers nothing.
      const openKeys = [...new Set(
        DOCUMENT_CATEGORY_FIELD_SEED.filter((r) => !r.isPii).map((r) => r.fieldKey),
      )];
      const probe = Object.fromEntries(openKeys.map((k) => [k, 'probe-value']));
      const { sanitizedData } = prepareAiPayload(probe);

      for (const key of openKeys) {
        expect(
          Object.prototype.hasOwnProperty.call(sanitizedData, key),
          `open-tier key "${key}" is stripped by prepareAiPayload — rename or seal it`,
        ).toBe(true);
      }
    });

    it('drops a credential key however it is spelled', () => {
      // The narrowing below must not open a hole. Each of these IS a credential
      // and must never reach a model, in any casing or separator style.
      const { sanitizedData } = prepareAiPayload({
        cvv: '123', card_cvv: '123', cards: 'x', linked_cards: 'x',
        pin: '1234', upi_pin: '1234', pinCode: '400001', atm_pin: '9',
        password: 'x', net_banking_username: 'x', netBankingUsername: 'x',
        login_username: 'x', loginUsername: 'x', client_secret: 'x',
        auth_token: 'x', private_key: 'x', passphrase: 'x',
      });
      expect(Object.keys(sanitizedData)).toEqual([]);
    });

    it('does not eat a legitimate key that merely CONTAINS a short forbidden word', () => {
      // `cin_or_llpin` ends in "llpin", which contains "pin". Under plain
      // substring matching it was silently dropped from every AI payload — a
      // company identifier printed on every MoA that no analysis ever saw, with
      // nothing anywhere saying why. It is SEALED, which is how it escaped the
      // open-tier check above.
      const { sanitizedData } = prepareAiPayload({
        cin_or_llpin: 'U72200KA2015PTC080000',
        shipping_date: '2024-01-01',
        mapping_notes: 'x',
        tokenised_ref: 'x',
      });
      expect(Object.keys(sanitizedData).sort())
        .toEqual(['cin_or_llpin', 'mapping_notes', 'shipping_date', 'tokenised_ref']);
    });

    it('keeps every SEALED key out of the forbidden list too, unless it is a credential', () => {
      // The open-tier check above is not enough: a sealed key that the shield
      // drops still vanishes from analysis, and that is how cin_or_llpin went
      // unnoticed. Genuine credentials are expected to be dropped and are
      // named here so the exception stays a short, deliberate list.
      const CREDENTIALS = new Set(['cvv', 'cards', 'net_banking_username', 'login_username']);
      const sealedKeys = [...new Set(
        DOCUMENT_CATEGORY_FIELD_SEED.filter((r) => r.isPii).map((r) => r.fieldKey),
      )].filter((k) => !CREDENTIALS.has(k));
      const { sanitizedData } = prepareAiPayload(
        Object.fromEntries(sealedKeys.map((k) => [k, 'probe'])),
      );
      for (const key of sealedKeys) {
        expect(
          Object.prototype.hasOwnProperty.call(sanitizedData, key),
          `sealed key "${key}" is silently stripped by prepareAiPayload`,
        ).toBe(true);
      }
    });

    it('has field labels the masker leaves untouched', () => {
      // Labels travel with the open tier into prompts. A label containing an
      // email, a 9+ digit run or a PAN-shaped token gets silently rewritten.
      for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
        expect(maskSensitiveText(row.fieldLabel), `label "${row.fieldLabel}" is rewritten`)
          .toBe(row.fieldLabel);
      }
    });

    it('encrypts something in every category', () => {
      // Every category has at least the sealed baseline (holder_name, notes),
      // so this can never be zero. An empty list would mean the whole category
      // is stored in the clear.
      for (const cat of DOCUMENT_CATEGORY_SEED) {
        expect(encryptedFieldsFor(cat).length, `${label(cat)} encrypts nothing`)
          .toBeGreaterThan(0);
      }
    });
  });

  describe('Per-category CSV (what the table stores)', () => {
    it('has exactly one entry per category', () => {
      expect(DOCUMENT_CATEGORY_ENCRYPTED_FIELDS).toHaveLength(DOCUMENT_CATEGORY_SEED.length);
      const keys = DOCUMENT_CATEGORY_ENCRYPTED_FIELDS.map(label);
      expect(new Set(keys).size).toBe(keys.length);
      expect(new Set(keys)).toEqual(new Set(DOCUMENT_CATEGORY_SEED.map(label)));
    });

    it('lists exactly the isPii fields of that category, in order', () => {
      for (const policy of DOCUMENT_CATEGORY_ENCRYPTED_FIELDS) {
        const expected = DOCUMENT_CATEGORY_FIELD_SEED
          .filter((f) => f.moduleKey === policy.moduleKey
            && f.documentKey === policy.documentKey && f.isPii)
          .map((f) => f.fieldKey);
        expect(policy.encryptedFields, label(policy)).toEqual(expected);
      }
    });

    it('round-trips through the CSV encoding', () => {
      for (const policy of DOCUMENT_CATEGORY_ENCRYPTED_FIELDS) {
        expect(parseEncryptedFields(policy.encryptedFieldsCsv)).toEqual([...policy.encryptedFields]);
      }
    });

    it('contains no comma or whitespace inside a field key', () => {
      // A key containing the delimiter would split into two phantom keys that
      // match nothing — the field would silently stop being encrypted.
      for (const policy of DOCUMENT_CATEGORY_ENCRYPTED_FIELDS) {
        for (const key of policy.encryptedFields) {
          expect(key, `"${key}" in ${label(policy)}`).not.toMatch(/[,\s]/);
        }
      }
    });

    it('fits the text column and stays a sane length', () => {
      for (const policy of DOCUMENT_CATEGORY_ENCRYPTED_FIELDS) {
        expect(policy.encryptedFieldsCsv.length).toBeGreaterThan(0);
        expect(policy.encryptedFieldsCsv).not.toMatch(/^,|,$|,,/);
      }
    });

    it('tolerates a hand-edited CSV', () => {
      // The column is operator-editable, so spacing and stray commas must not
      // produce a phantom '' key that quietly matches nothing.
      expect(parseEncryptedFields(' pan_number , , father_name ')).toEqual([
        'pan_number', 'father_name',
      ]);
      expect(parseEncryptedFields('')).toEqual([]);
      expect(parseEncryptedFields(null)).toEqual([]);
      expect(parseEncryptedFields(undefined)).toEqual([]);
    });
  });

  /**
   * `mandatory_fields` and `all_fields` — the two flat projections of the form
   * spec that 0033 added beside `encrypted_fields`.
   *
   * These are NOT policy: nothing validates against them, so a wrong list is a
   * wrong ANSWER rather than a leak. What has to hold is that they cannot
   * disagree with the `fields` spec they are projected from — the whole point
   * of the columns is that a SQL reader and the add form describe the same
   * sub-category.
   */
  describe('Field lists (mandatory_fields / all_fields)', () => {
    it('has exactly one entry per category', () => {
      expect(DOCUMENT_CATEGORY_FIELD_LISTS).toHaveLength(DOCUMENT_CATEGORY_SEED.length);
      const keys = DOCUMENT_CATEGORY_FIELD_LISTS.map(label);
      expect(new Set(keys).size).toBe(keys.length);
      expect(new Set(keys)).toEqual(new Set(DOCUMENT_CATEGORY_SEED.map(label)));
    });

    it('lists every field of that category, in form order, once', () => {
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        const expected = fieldsFor(lists).map((f) => f.fieldKey);
        expect(lists.allFields, label(lists)).toEqual(expected);
        expect(new Set(lists.allFields).size, `${label(lists)} repeats a key`)
          .toBe(lists.allFields.length);
      }
    });

    it('lists exactly the isRequired fields, in form order', () => {
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        const expected = fieldsFor(lists).filter((f) => f.isRequired).map((f) => f.fieldKey);
        expect(lists.mandatoryFields, label(lists)).toEqual(expected);
      }
    });

    it('agrees with the per-category lookups', () => {
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        expect(allFieldKeysFor(lists), label(lists)).toEqual([...lists.allFields]);
        expect(mandatoryFieldsFor(lists), label(lists)).toEqual([...lists.mandatoryFields]);
      }
    });

    it('gives every category the baseline keys, custom_fields included', () => {
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        for (const baseline of ['document_title', 'holder_name', 'issue_date', 'notes', 'custom_fields']) {
          expect(lists.allFields, `${label(lists)} is missing ${baseline}`).toContain(baseline);
        }
      }
    });

    it('keeps all_fields a superset of both other lists', () => {
      // A key in mandatory_fields or encrypted_fields that all_fields omits
      // would describe a field the form never renders.
      const sealed = new Map(DOCUMENT_CATEGORY_ENCRYPTED_FIELDS.map((p) => [label(p), p.encryptedFields]));
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        const all = new Set(lists.allFields);
        for (const key of lists.mandatoryFields) {
          expect(all.has(key), `${label(lists)}: mandatory ${key} is not in all_fields`).toBe(true);
        }
        for (const key of sealed.get(label(lists)) ?? []) {
          expect(all.has(key), `${label(lists)}: sealed ${key} is not in all_fields`).toBe(true);
        }
      }
    });

    it('always demands the record\'s title and never demands free text', () => {
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        // The write path has always refused an empty title; a list that did not
        // say so would tell a caller the opposite of what the server does.
        expect(lists.mandatoryFields, label(lists)).toContain('document_title');
        // Nobody is made to invent an extra label/value row, or a note, before
        // a record can be saved.
        expect(lists.mandatoryFields, label(lists)).not.toContain('custom_fields');
        expect(lists.mandatoryFields, label(lists)).not.toContain('notes');
      }
    });

    it('round-trips through the CSV encoding', () => {
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        expect(parseFieldCsv(lists.allFieldsCsv), label(lists)).toEqual([...lists.allFields]);
        expect(parseFieldCsv(lists.mandatoryFieldsCsv), label(lists))
          .toEqual([...lists.mandatoryFields]);
        expect(lists.allFieldsCsv).not.toMatch(/^,|,$|,,/);
        expect(lists.mandatoryFieldsCsv).not.toMatch(/^,|,$|,,/);
      }
    });

    it('never writes an empty all_fields', () => {
      // '' is the seed script's signal for "not seeded". A category that
      // legitimately produced one would make that signal a lie.
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        expect(lists.allFieldsCsv.length, label(lists)).toBeGreaterThan(0);
      }
    });

    it('reads the same CSV as the encryption policy does', () => {
      // One parser for all three columns — an alias, not a copy.
      expect(parseFieldCsv).toBe(parseEncryptedFields);
    });
  });

  /**
   * `ocr_fields` — which keys a scan is asked to read off the document.
   *
   * Unlike its two sibling columns this one is NOT merely descriptive:
   * `ocrFieldKeys` builds both the column and the ask-list
   * `extractCategoryFields` sends to the model. A wrong list here is a field the
   * add form renders and autofill silently never fills, or a key the model is
   * asked to invent because no document states it.
   */
  describe('OCR fields (ocr_fields)', () => {
    /**
     * The taxonomy keys the follow-up page runs on — every `reminder:` mapping
     * in src/lib/records/fieldMap.ts. Read from that file rather than restated,
     * so a new renewal cannot be added there and go unasked-for here.
     */
    const REMINDER_KEYS = new Set(
      Array.from(
        readFileSync(join(__dirname, '..', 'src', 'lib', 'records', 'fieldMap.ts'), 'utf8')
          .matchAll(/candidates:\s*\[([^\]]*)\][^}]*reminder:/g),
      ).flatMap((m) => Array.from(m[1].matchAll(/'([a-z_]+)'/g)).map((k) => k[1])),
    );

    it('reads the reminder keys out of fieldMap.ts', () => {
      // Guards the regex above: a silent zero would make the alert test below
      // assert nothing at all.
      expect(REMINDER_KEYS.size).toBeGreaterThanOrEqual(10);
      expect(REMINDER_KEYS).toContain('valid_to');
      expect(REMINDER_KEYS).toContain('expiry_date');
    });

    it('is all_fields minus exactly the keys no document states', () => {
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        const expected = lists.allFields.filter((k) => !NEVER_PRINTED_KEYS.includes(k));
        expect(lists.ocrFields, label(lists)).toEqual(expected);
      }
    });

    it('never asks a model to invent what the user authored', () => {
      // A model asked for a field the page does not carry does not answer
      // blank — it answers plausibly. `notes` is the sharp case: told to fill
      // "Notes", a model summarises the document, and that invented prose lands
      // in a SEALED field indistinguishable from something the user wrote.
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        for (const key of ['holder_name', 'custom_fields', 'notes']) {
          expect(lists.ocrFields, `${label(lists)} asks for ${key}`).not.toContain(key);
        }
      }
    });

    it('never asks a model for a credential', () => {
      // The worst of these is `cvv`: a credit-card STATEMENT does not print a
      // security code, so asking produces an invented one, filed under the
      // user's own card. `card_last_four` is what a statement actually shows.
      const CREDENTIALS = ['cvv', 'card_number', 'card_expiry',
        'net_banking_username', 'login_username', 'cards'];
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        for (const key of CREDENTIALS) {
          expect(lists.ocrFields, `${label(lists)} asks for ${key}`).not.toContain(key);
        }
      }
      // …and the category that owns them still COLLECTS them on its form.
      const card = DOCUMENT_CATEGORY_FIELD_LISTS
        .find((l) => l.documentKey === 'credit_card_statements')!;
      expect(card.allFields).toContain('cvv');
      expect(card.ocrFields).toContain('card_last_four');
    });

    it('excludes a key from READING without excluding it from the form', () => {
      // isPrinted and isPii are orthogonal. An unreadable field is still a
      // field the user may fill in and the vault may seal.
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        const all = new Set(lists.allFields);
        for (const key of lists.ocrFields) {
          expect(all.has(key), `${label(lists)}: ${key} is not in all_fields`).toBe(true);
        }
        for (const key of NEVER_PRINTED_KEYS) {
          if (!all.has(key)) continue;
          expect(lists.ocrFields, `${label(lists)}: ${key} is readable`).not.toContain(key);
        }
      }
    });

    it('asks for nothing the AI privacy shield would strip on the way out', () => {
      // The prompt used to ask for exactly what prepareAiPayload refuses to
      // carry — cvv, cards, login_username, net_banking_username. Asking for a
      // key the shield drops is incoherent at best and, for a credential,
      // actively harmful.
      const fold = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
      const FORBIDDEN = ['password', 'netBankingUsername', 'cards', 'cvv',
        'loginUsername', 'clientSecret', 'privateKey', 'passphrase'].map(fold);
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        for (const key of lists.ocrFields) {
          const hit = FORBIDDEN.find((f) => fold(key).includes(f));
          expect(hit, `${label(lists)}: ocr asks for ${key}, which the shield drops`)
            .toBeUndefined();
        }
      }
    });

    it('asks for every mandatory field autofill could fill', () => {
      // A field the form DEMANDS but the scan never reads is one autofill can
      // never satisfy — the user is sent back to type it by hand with no clue
      // why that one input stayed blank. `holder_name` is exempt: it is never
      // mandatory, and is answered by the "Belongs to" picker.
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        const asked = new Set(lists.ocrFields);
        for (const key of lists.mandatoryFields) {
          if (NEVER_PRINTED_KEYS.includes(key)) continue;
          expect(asked.has(key), `${label(lists)}: mandatory ${key} is never read`).toBe(true);
        }
      }
    });

    it('asks for every date the follow-up page raises an alert on', () => {
      // A renewal date nobody extracts is a reminder that never fires.
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        const asked = new Set(lists.ocrFields);
        for (const key of lists.allFields) {
          if (!REMINDER_KEYS.has(key)) continue;
          expect(asked.has(key), `${label(lists)}: alert date ${key} is never read`).toBe(true);
        }
      }
    });

    it('agrees with the per-category lookup and the shared helper', () => {
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        expect(ocrFieldsFor(lists), label(lists)).toEqual([...lists.ocrFields]);
        // The helper the PROMPT calls, on the same spec, must answer the same.
        expect(ocrFieldKeys(fieldsFor(lists)), label(lists)).toEqual([...lists.ocrFields]);
      }
    });

    it('narrows the old blanket rule by exactly the never-printed keys', () => {
      // The prompt builder used to inline "everything except custom_fields and
      // holder_name", which is how it came to ask for a CVV. The difference
      // between then and now must be the deliberate list and nothing else — a
      // field quietly dropped from a scan is a field the user must retype with
      // no clue why.
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        const legacy = fieldsFor(lists)
          .filter((f) => f.fieldKey && f.fieldKey !== 'custom_fields' && f.fieldKey !== 'holder_name')
          .map((f) => f.fieldKey);
        const dropped = legacy.filter((k) => !lists.ocrFields.includes(k));
        expect(dropped.every((k) => NEVER_PRINTED_KEYS.includes(k)), label(lists)).toBe(true);
        // Nothing was ADDED to the ask-list by the rewrite.
        expect(lists.ocrFields.every((k) => legacy.includes(k)), label(lists)).toBe(true);
      }
    });

    it('stamps isPrinted:false on the stored spec, and only there', () => {
      // The JSONB column an operator edits should SAY why a field is not read,
      // rather than leaving them to infer it. Writing `true` on all 1,200 rows
      // would only restate the default.
      for (const cat of DOCUMENT_CATEGORY_FIELD_SPECS) {
        for (const f of cat.fields as any[]) {
          if (NEVER_PRINTED_KEYS.includes(f.fieldKey)) {
            expect(f.isPrinted, `${label(cat)}/${f.fieldKey}`).toBe(false);
          } else {
            expect(f.isPrinted, `${label(cat)}/${f.fieldKey}`).toBeUndefined();
          }
        }
      }
    });

    it('lets an explicit isPrinted override the key list, both ways', () => {
      expect(ocrFieldKeys([{ fieldKey: 'notes', isPrinted: true }])).toEqual(['notes']);
      expect(ocrFieldKeys([{ fieldKey: 'pan_number', isPrinted: false }])).toEqual([]);
    });

    it('round-trips through the CSV encoding and is never empty', () => {
      for (const lists of DOCUMENT_CATEGORY_FIELD_LISTS) {
        expect(parseFieldCsv(lists.ocrFieldsCsv), label(lists)).toEqual([...lists.ocrFields]);
        expect(lists.ocrFieldsCsv).not.toMatch(/^,|,$|,,/);
        // '' is the seed script's "not seeded" signal, so no category may
        // legitimately produce one.
        expect(lists.ocrFieldsCsv.length, label(lists)).toBeGreaterThan(0);
      }
    });

    it('ignores a spec entry with no field key', () => {
      // The stored column is hand-editable JSON; a malformed entry must drop
      // out rather than become a '' key the prompt asks the model to fill.
      expect(ocrFieldKeys([
        { fieldKey: 'pan_number' }, { fieldKey: '' }, { fieldKey: 'holder_name' },
      ])).toEqual(['pan_number']);
    });
  });

  describe('Dynamic application (splitRecordFields)', () => {
    const policy = encryptedFieldsFor({ moduleKey: 'identity', documentKey: 'pan_card' });

    it('seals only the listed fields the record actually carries', () => {
      // The policy names date_of_birth; this record does not have one, and no
      // empty sealed value may be invented for it.
      const { sealed, open } = splitRecordFields(policy, {
        pan_number: 'ABCDE1234F',
        document_title: 'PAN card',
        issue_date: '2019-04-01',
      });
      expect(Object.keys(sealed)).toEqual(['pan_number']);
      expect(Object.keys(open).sort()).toEqual(['document_title', 'issue_date']);
    });

    it('sends an unlisted field to the open tier', () => {
      const { sealed, open } = splitRecordFields(policy, { some_new_key: 'x' });
      expect(sealed).toEqual({});
      expect(open).toEqual({ some_new_key: 'x' });
    });

    it('does not seal null, undefined or empty values', () => {
      const { sealed, open } = splitRecordFields(policy, {
        pan_number: '',
        father_name: null,
        date_of_birth: undefined,
      });
      expect(sealed).toEqual({});
      expect(Object.keys(open).sort()).toEqual(['date_of_birth', 'father_name', 'pan_number']);
    });

    it('handles a missing record without throwing', () => {
      expect(splitRecordFields(policy, null)).toEqual({ sealed: {}, open: {} });
      expect(splitRecordFields(policy, undefined)).toEqual({ sealed: {}, open: {} });
    });

    it('seals nothing when the policy is empty — the fail-open case to avoid', () => {
      // Documents the consequence explicitly: an empty list is not "encrypt
      // everything", it is "encrypt nothing". Coverage tests above are what
      // keep a real category from ever reaching this state.
      const { sealed, open } = splitRecordFields([], { pan_number: 'ABCDE1234F' });
      expect(sealed).toEqual({});
      expect(open).toEqual({ pan_number: 'ABCDE1234F' });
    });
  });

  describe('Migration parity (drizzle/0015_taxonomy_reshuffle.sql)', () => {
    // The same rows exist in two places — the TS constant and the policy VALUES
    // block in 0015. This is what catches a field added to one but not the other.
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    // 0015 has two VALUES blocks: the 6-column reshuffle rows and the 3-column
    // policy rows. Only the latter shape matches this pattern.
    const rowRe = /^ {2}\('([a-z0-9_]+)','([a-z0-9_]+)','([a-z0-9_,]*)'\),?$/gm;
    const migrationRows = Array.from(sql.matchAll(rowRe)).map((m) => ({
      categoryCode: `${m[1]}.${m[2]}`,
      encryptedFieldsCsv: m[3],
    }));

    it('states the policy for every category 0015 reshuffled, under its 0023 key', () => {
      // 0015 covered the 83 categories that existed then; the 15 miscellaneous
      // rows arrived in 0017 and had their policy set by 0018, asserted below.
      // Its rows name the PRE-0023 modules, so each is translated through the
      // re-key before comparison — which also proves 0023 accounts for all of
      // them.
      const stated = migrationRows
        .map((r) => {
          const [oldModule, oldDocument] = r.categoryCode.split('.');
          const key = rekeyed(oldModule, oldDocument);
          expect(key, `${r.categoryCode} has no 0023 re-key row`).not.toBeNull();
          return key as string;
        })
        // 0050 retired the whole personal `business` module, so the 16 policies
        // 0015 stated for it describe categories that no longer exist. They are
        // dropped here rather than deleted from 0015: an applied migration is
        // history and is never edited.
        .filter((key) => !key.startsWith('business.'));
      // PERSONAL categories only. 0015 predates the business taxonomy by
      // thirty-five migrations, so it can only be expected to state a policy
      // for the categories that existed when it ran — and 0050 retired the
      // `business` module whose rows it did state.
      const expected = DOCUMENT_CATEGORY_ENCRYPTED_FIELDS.filter(
        (p) => !isBusinessModule(p.moduleKey),
      );
      expect(stated).toHaveLength(expected.length);
      expect([...stated].sort()).toEqual(
        expected.map((p) => `${p.moduleKey}.${p.documentKey}`).sort());
    });

    it('leaves the business taxonomy to the dictionary, but seals it all the same', () => {
      // The business categories have no migration row and do not need one:
      // `loadEncryptionPolicy` falls back to the compiled dictionary, which is
      // where their policy comes from. What must NOT happen is a business
      // category ending up with an empty policy — that is a sub-category whose
      // GSTIN, PAN or amount would sit in the open tier in the clear.
      const business = DOCUMENT_CATEGORY_ENCRYPTED_FIELDS.filter(
        (p) => isBusinessModule(p.moduleKey),
      );
      expect(business).toHaveLength(84);
      const unsealed = business.filter((p) => p.encryptedFields.length === 0);
      expect(unsealed.map((p) => `${p.moduleKey}/${p.documentKey}`)).toEqual([]);
      // `reference_number` is the one every business category carries.
      for (const p of business) {
        expect(p.encryptedFields, `${p.moduleKey}/${p.documentKey}`)
          .toContain('reference_number');
      }
    });

    it('UPDATEs the existing rows — 0008 already created them', () => {
      // An upsert would be a no-op here: all 83 rows exist and it is their
      // CONTENTS that changed.
      expect(sql).toContain('UPDATE "document_category_fields"');
      expect(sql).toContain('IS DISTINCT FROM v.encrypted_fields');
    });

    it('resolves category ids by the composite key, not a hard-coded UUID', () => {
      // 0012 split the dotted `code` column into (module_key, document_key), so
      // joining on `code` — as 0008 did — would not compile any more.
      expect(sql).toContain('dc.module_key = v.module_key');
      expect(sql).toContain('dc.document_key = v.document_key');
      expect(sql).not.toContain('dc.code');
    });

    it('leaves no category with an empty policy', () => {
      // An empty list means "encrypt nothing", so it is the one value that must
      // never appear. The baseline `notes` guarantees it.
      for (const row of migrationRows) {
        expect(row.encryptedFieldsCsv, `${row.categoryCode} has an empty policy`).not.toBe('');
      }
    });

    it('removes holder_name from every stored policy', () => {
      for (const row of migrationRows) {
        expect(row.encryptedFieldsCsv.split(','), row.categoryCode).not.toContain('holder_name');
      }
    });
  });

  describe('Miscellaneous policy parity (drizzle/0018_miscellaneous_policy_union.sql)', () => {
    const sql = readFileSync(MISC_MIGRATION_PATH, 'utf8');
    const rowRe = /^  \('([a-z0-9_]+)','(miscellaneous)','([a-z0-9_,]*)'\)[,;]?(?:-->.*)?$/gm;
    const rows = Array.from(sql.matchAll(rowRe))
      .map((m) => ({ moduleKey: m[1], csv: m[3] }));

    it('has had all 15 of its categories retired by 0023', () => {
      // 0023 replaced the fifteen per-module buckets with one global catch-all.
      // These policy rows still exist in the table behind inactive categories;
      // what matters is that none of them is live any more.
      expect(rows).toHaveLength(15);
      for (const r of rows) {
        expect(rekeyed(r.moduleKey, 'miscellaneous'),
          `${r.moduleKey}/miscellaneous is still live`).toBeNull();
      }
    });

    it('has its union subsumed by the one catch-all — nothing became less sealed', () => {
      // THE assertion that makes the collapse safe. Every field any of the
      // fifteen buckets sealed must still be sealed by `other/uncategorized`, or
      // 0023 quietly moved a value into the open tier.
      const catchAll = DOCUMENT_CATEGORY_ENCRYPTED_FIELDS.find(
        (p) => p.moduleKey === UNCATEGORIZED.moduleKey
          && p.documentKey === UNCATEGORIZED.documentKey)!;
      for (const r of rows) {
        const lost = r.csv.split(',').filter((f) => f && !catchAll.encryptedFields.includes(f));
        expect(lost, `${r.moduleKey}/miscellaneous sealed these and the catch-all does not`)
          .toEqual([]);
      }
    });

    it('never leaves one sealing only the baseline', () => {
      // The bug 0018 exists to fix: a baseline-only policy on the category that
      // receives UNIDENTIFIED records would write their identifiers in the clear.
      for (const r of rows) {
        expect(r.csv.split(',').length, `${r.moduleKey}/miscellaneous seals too little`)
          .toBeGreaterThan(1);
      }
      expect(sql).toContain('still carry the baseline-only policy');
    });
  });

  describe('Structural parity (drizzle/0008_document_category_fields_csv.sql)', () => {
    // 0008 is what reshaped the table; these assertions describe that reshape
    // and stay pinned to it even as later migrations re-state the policy.
    const sql = structureSql;

    it('drops tenant_id and the per-field columns', () => {
      for (const col of ['tenant_id', 'field_key', 'field_label', 'data_type', 'is_pii', 'is_required', 'sort_order']) {
        expect(sql, `0008 does not drop ${col}`).toContain(`DROP COLUMN IF EXISTS "${col}"`);
      }
    });

    it('retires the RLS policy before dropping the column it references', () => {
      const dropPolicy = sql.indexOf('DROP POLICY IF EXISTS tenant_isolation');
      const dropColumn = sql.indexOf('DROP COLUMN IF EXISTS "tenant_id"');
      expect(dropPolicy).toBeGreaterThan(-1);
      expect(dropPolicy).toBeLessThan(dropColumn);
    });

    it('collapses existing rows rather than discarding a hand-edited policy', () => {
      expect(sql).toContain('string_agg(field_key');
      expect(sql).toContain('WHERE is_pii');
    });
  });

  /**
   * drizzle/0035 — dropping the orphaned policy rows.
   *
   * Deleting a policy row is the one edit to this table that can REMOVE
   * sealing, so the migration's guards are the safety, not a formality. These
   * assert the guards are present and that the delete is expressed as a
   * predicate — a hard-coded id list would delete nothing in one database and
   * the wrong rows in another, since ids are generated at migration time.
   */
  describe('Retired-policy cleanup (drizzle/0035)', () => {
    const sql = dropRetiredSql;

    it('deletes by joining the retired categories, not by id', () => {
      expect(sql).toMatch(/DELETE FROM "document_category_fields"/);
      expect(sql).toMatch(/USING "document_categories"/);
      expect(sql).toMatch(/c\."is_active" = false/);
      // No UUID literal anywhere — the predicate is the whole selection.
      expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });

    it('refuses to run if any document is filed under a retired category', () => {
      // Such a record would lose the list naming which of its fields are
      // sealed. The check must come BEFORE the delete, or it asserts nothing.
      const guard = sql.indexOf('are filed under a retired category');
      const del = sql.indexOf('DELETE FROM "document_category_fields"');
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(del);
      expect(sql).toContain('FROM "documents"');
      // Soft-deleted rows count, so no deleted_at filter narrows the check.
      expect(sql).not.toMatch(/d\."deleted_at" IS NULL/);
      // The denormalised pair is checked alongside the FK.
      expect(sql).toContain('"category_module_key"');
      expect(sql).toContain('"category_document_key"');
    });

    it('asserts one policy row per active category afterwards', () => {
      // The failure this guards against — a LIVE category left with no row — is
      // the one that would genuinely encrypt nothing.
      const del = sql.indexOf('DELETE FROM "document_category_fields"');
      const check = sql.indexOf('expected one policy row per active category');
      expect(check).toBeGreaterThan(del);
      expect(sql).toContain('RAISE EXCEPTION');
    });

    it('leaves the retired categories themselves in place', () => {
      // documents.category_id is ON DELETE RESTRICT and the rule for that table
      // is retire-never-delete.
      expect(sql).not.toMatch(/DELETE FROM "document_categories"/);
    });
  });
});

