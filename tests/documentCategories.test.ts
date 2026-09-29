import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DOCUMENT_CATEGORY_MODULES,
  DOCUMENT_CATEGORY_SEED,
  MODULE_COLORS,
  UNCATEGORIZED,
  buildAiCategoryList,
  isSeededCategory,
  taxonomyOf,
} from '../src/lib/documentCategories';
import { CATEGORY_MIRRORS, isMirrorAlias } from '../src/lib/categoryMirrors';
import { maskSensitiveText } from '../src/lib/aiPrivacyMasker';

/**
 * Guards the document category taxonomy (src/lib/documentCategories.ts), which
 * is the single source of truth every dropdown, filter and backfill derives
 * from. Pure — no DB, no network.
 *
 * The migration-parity test is the important one: the 83 rows exist in two
 * places (the TS constant and a migration's VALUES block) and would otherwise
 * drift the first time someone adds a category.
 *
 * Parity is asserted against 0023, the migration that moved the taxonomy onto
 * the master document table and is therefore what states it as it now exists.
 * 0004 and 0015 are applied migrations describing earlier shapes and must never
 * be edited. See tests/moduleVocabulary.test.ts for the invariants the
 * realignment had to preserve.
 */

/**
 * The master document table: 14 modules with 82 sub-categories between them,
 * plus module 15 `other` holding the single global catch-all. 0023 retired the
 * 15 per-module `miscellaneous` buckets 0017 had added.
 */
/** Personal modules 1..13 then the catch-all. `business` (16) left in 0050. */
const EXPECTED_PERSONAL_COUNTS = [8, 10, 6, 8, 4, 6, 4, 4, 5, 2, 2, 3, 4, 1];
/** Business modules 101..114, added by 0050. */
const EXPECTED_BUSINESS_COUNTS = [8, 7, 8, 7, 7, 6, 7, 7, 5, 5, 5, 4, 4, 4];
const EXPECTED_MODULE_COUNTS = [...EXPECTED_PERSONAL_COUNTS, ...EXPECTED_BUSINESS_COUNTS];
const TOTAL_PERSONAL = 67;
const TOTAL_BUSINESS = 84;
const TOTAL_SUBCATEGORIES = TOTAL_PERSONAL + TOTAL_BUSINESS;

const MIGRATION_PATH = join(__dirname, '..', 'drizzle', '0023_master_taxonomy_realignment.sql');
const BUSINESS_MIGRATION_PATH = join(__dirname, '..', 'drizzle', '0050_business_accounts.sql');

/**
 * 0036 reaped the 15 tombstones 0023 left behind, once 0035 had removed their
 * encrypt policies. It is one of the two sanctioned deletions from this table,
 * so what makes it safe — the guards — is what these assertions are about.
 */
const REAP_PATH = join(__dirname, '..', 'drizzle', '0036_drop_retired_categories.sql');

/**
 * 0055 is the other: the 16 rows of the personal `business` module, which 0050
 * had retired. Same standard applied — a delete from this table is only ever as
 * safe as the guard that refuses to run it.
 */
const DROP_BUSINESS_PATH = join(
  __dirname, '..', 'drizzle', '0055_drop_retired_business_module.sql');

describe('Document category taxonomy', () => {
  describe('Module structure', () => {
    it('has 28 modules — 14 personal (1..15, less the retired 14) and 14 business (101..114)', () => {
      expect(DOCUMENT_CATEGORY_MODULES).toHaveLength(28);
      expect(DOCUMENT_CATEGORY_MODULES.map((m) => m.moduleNo)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15,
        ...Array.from({ length: 14 }, (_, i) => 101 + i),
      ]);
    });

    it('has the expected number of sub-categories per module', () => {
      expect(DOCUMENT_CATEGORY_MODULES.map((m) => m.subCategories.length)).toEqual(
        EXPECTED_MODULE_COUNTS,
      );
    });

    it('has 151 sub-categories in total', () => {
      const total = DOCUMENT_CATEGORY_MODULES.reduce((n, m) => n + m.subCategories.length, 0);
      expect(total).toBe(TOTAL_SUBCATEGORIES);
      expect(EXPECTED_MODULE_COUNTS.reduce((a, b) => a + b, 0)).toBe(TOTAL_SUBCATEGORIES);
    });

    it('has unique module keys', () => {
      const keys = DOCUMENT_CATEGORY_MODULES.map((m) => m.moduleKey);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('files the catch-all in its own `other` module, grantable like any other', () => {
      // A `system` pseudo-module would be a permission nobody can grant, so an
      // unfiled document would be invisible to every STANDARD user. `other` is a
      // real module in every respect except that the sidebar hides it.
      expect(UNCATEGORIZED.moduleKey).toBe('other');
      expect(UNCATEGORIZED.documentKey).toBe('uncategorized');
      expect(UNCATEGORIZED.documentName).toBe('Others');
      const other = DOCUMENT_CATEGORY_MODULES.find((m) => m.moduleKey === 'other')!;
      expect(other.subCategories.map((s) => s.documentKey)).toEqual(['uncategorized']);
      expect(other.moduleNo).toBe(15);
    });
  });

  describe('Keys', () => {
    it('are unique as a PAIR across the whole seed', () => {
      const keys = DOCUMENT_CATEGORY_SEED.map((r) => `${r.moduleKey}/${r.documentKey}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('does NOT have globally unique documentKeys — the pair is the key', () => {
      // `registration_certificate` is a real collision (vehicle + business).
      // Asserted so nobody "simplifies" the schema back to one column.
      const documentKeys = DOCUMENT_CATEGORY_SEED.map((r) => r.documentKey);
      expect(new Set(documentKeys).size).toBeLessThan(documentKeys.length);
    });

    it('are lower_snake_case slugs with no dot in either half', () => {
      const SLUG = /^[a-z][a-z0-9_]*$/;
      for (const row of DOCUMENT_CATEGORY_SEED) {
        expect(row.moduleKey, `${row.moduleKey} is not a valid module key`).toMatch(SLUG);
        expect(row.documentKey, `${row.documentKey} is not a valid document key`).toMatch(SLUG);
      }
    });

    it('fit the varchar(60) columns they are stored in', () => {
      for (const row of DOCUMENT_CATEGORY_SEED) {
        expect(row.moduleKey.length, row.moduleKey).toBeLessThanOrEqual(60);
        expect(row.documentKey.length, row.documentKey).toBeLessThanOrEqual(60);
      }
    });
  });

  describe('Seed rows', () => {
    it('is the 82 master-table rows plus the catch-all', () => {
      expect(DOCUMENT_CATEGORY_SEED).toHaveLength(TOTAL_SUBCATEGORIES);
      expect(DOCUMENT_CATEGORY_SEED.some(
        (r) => r.moduleKey === UNCATEGORIZED.moduleKey
            && r.documentKey === UNCATEGORIZED.documentKey)).toBe(true);
    });

    it('has a strictly increasing sortOrder', () => {
      const orders = DOCUMENT_CATEGORY_SEED.map((r) => r.sortOrder);
      for (let i = 1; i < orders.length; i++) {
        expect(orders[i], `sortOrder is not increasing at index ${i}`).toBeGreaterThan(orders[i - 1]);
      }
    });
  });

  describe('The one catch-all', () => {
    it('has retired the 15 per-module miscellaneous buckets', () => {
      // 0017 gave every module its own; 0023 replaced all 15 with one global
      // bucket. One of them reappearing means MODULE_CATEGORY's per-scope
      // defaults would silently want to point back at it.
      const misc = DOCUMENT_CATEGORY_SEED.filter((r) => r.documentKey === 'miscellaneous');
      expect(misc).toEqual([]);
    });

    it('is the only category in its module, so nothing can be filed beside it', () => {
      const inOther = DOCUMENT_CATEGORY_SEED.filter((r) => r.moduleKey === 'other');
      expect(inOther).toHaveLength(1);
      expect(inOther[0].documentKey).toBe('uncategorized');
    });
  });

  describe('Migration parity (drizzle/0023 then drizzle/0050)', () => {
    // 0023 carries one row per category: the OLD (module_key, document_key) it is
    // matched on, and the NEW module_no / module_key / module_name /
    // document_key / sort_order it is rewritten to. Those new values ARE the
    // taxonomy, so they must reproduce the TS constant exactly — that is what
    // stops the DB and the code disagreeing about where a category lives.
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    const rowRe = new RegExp(
      String.raw`^  \('([a-z0-9_]+)','([a-z0-9_]+)',\s*(\d+),'([a-z0-9_]+)','([^']*)','([a-z0-9_]+)',\s*(\d+),(true|false)\)`,
      'gm',
    );
    const allRows = Array.from(sql.matchAll(rowRe)).map((m) => ({
      oldModuleKey: m[1],
      oldDocumentKey: m[2],
      moduleNo: Number(m[3]),
      moduleKey: m[4],
      moduleName: m[5],
      documentKey: m[6],
      sortOrder: Number(m[7]),
      retire: m[8] === 'true',
    }));
    const surviving = allRows.filter((r) => !r.retire);
    const retired = allRows.filter((r) => r.retire);

    /**
     * 0050 moves the taxonomy on again: it retires the whole personal
     * `business` module and inserts the 84 business rows.
     *
     * So parity is CUMULATIVE, not a property of one migration. Pinning it to
     * 0023 alone would have meant that the first taxonomy migration after it
     * either broke this test or forced the constant to lie.
     */
    const businessSql = readFileSync(BUSINESS_MIGRATION_PATH, 'utf8');
    const bizRowRe = /^ {2}\((\d+),'([a-z0-9_]+)','((?:[^']|'')*)','([a-z0-9_]+)','((?:[^']|'')*)',(\d+)\)/gm;
    const businessRows = Array.from(businessSql.matchAll(bizRowRe)).map((m) => ({
      moduleNo: Number(m[1]),
      moduleKey: m[2],
      moduleName: m[3].replace(/''/g, "'"),
      documentKey: m[4],
      sortOrder: Number(m[6]),
    }));

    it('accounts for all 98 pre-0023 rows', () => {
      // 83 survivors + the 15 miscellaneous buckets it retires. A row missing
      // here keeps a dead module_key and vanishes from every dropdown, which is
      // exactly what the migration's own guard refuses to allow.
      expect(allRows).toHaveLength(98);
      expect(retired).toHaveLength(15);
      expect(retired.every((r) => r.oldDocumentKey === 'miscellaneous')).toBe(true);
    });

    it('inserts 84 business rows and retires the personal business module', () => {
      expect(businessRows).toHaveLength(84);
      expect(new Set(businessRows.map((r) => r.moduleKey)).size).toBe(14);
      // Retired, never deleted: documents.category_id is ON DELETE RESTRICT.
      expect(businessSql).toMatch(
        /UPDATE "document_categories"[\s\S]*?"is_active" = false[\s\S]*?"module_key" = 'business'/,
      );
      expect(businessSql).not.toMatch(/DELETE\s+FROM\s+"?document_categories/i);
    });

    it('re-keys every surviving category exactly as the TS constant states', () => {
      const actual = [
        // 0023's survivors, less the module 0050 retires...
        ...surviving.filter((r) => r.moduleKey !== 'business'),
        // ...plus the business taxonomy it inserts.
        ...businessRows,
      ]
        .map((r) => ({
          moduleNo: r.moduleNo,
          moduleKey: r.moduleKey,
          moduleName: r.moduleName,
          documentKey: r.documentKey,
          sortOrder: r.sortOrder,
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const expected = [...DOCUMENT_CATEGORY_SEED]
        .map((r) => ({
          moduleNo: r.moduleNo,
          moduleKey: r.moduleKey,
          moduleName: r.moduleName,
          documentKey: r.documentKey,
          sortOrder: r.sortOrder,
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      expect(actual).toEqual(expected);
    });

    it('never renames a document_key — only the module half moves', () => {
      // The document half names the Drive folder AND carries the encryption
      // policy through `document_category_fields`, which joins on category_id.
      // Renaming it would strand both.
      for (const row of surviving) {
        expect(row.documentKey, `${row.oldModuleKey}/${row.oldDocumentKey} was renamed`)
          .toBe(row.oldDocumentKey);
      }
    });

    it('matches on the OLD pair so the rewrite is exact', () => {
      // A wildcard on module_key would silently re-key any category added after
      // this migration was written.
      const oldPairs = allRows.map((r) => `${r.oldModuleKey}/${r.oldDocumentKey}`);
      expect(new Set(oldPairs).size, 'an old pair is listed twice').toBe(oldPairs.length);
      expect(sql).toContain('m.old_module_key = dc.module_key');
    });

    it('cascades the denormalised copies that name the Drive folder', () => {
      expect(sql).toContain('UPDATE documents d');
      expect(sql).toContain('UPDATE vault_json_files v');
      expect(sql).toContain("v.module <> 'passwords'");
    });

    it('retires the catch-alls rather than deleting them', () => {
      // documents.category_id is ON DELETE RESTRICT; a deleted category would
      // strand its documents.
      expect(sql).toContain('SET is_active = false');
      expect(sql).not.toMatch(/DELETE FROM document_categories/i);
    });

    it('drops the group tier the realignment replaces', () => {
      for (const column of ['group_key', 'group_no', 'group_name']) {
        expect(sql).toContain(`DROP COLUMN IF EXISTS "${column}"`);
      }
      expect(sql).toContain('document_categories_group_complete');
    });

    it('refuses to half-migrate, and tells the operator to reset the vault', () => {
      expect(sql).toContain('refusing to half-migrate');
      // Renaming module_key breaks the AES-GCM AAD of every existing object.
      expect(sql).toContain('reset_vault_data.ts --yes');
    });
  });

  describe('Module colours', () => {
    it('covers every module plus the system pseudo-module', () => {
      for (const m of DOCUMENT_CATEGORY_MODULES) {
        expect(MODULE_COLORS[m.moduleKey], `no colour for ${m.moduleKey}`).toBeDefined();
      }
      expect(MODULE_COLORS[UNCATEGORIZED.moduleKey]).toBeDefined();
    });
  });

  describe('isSeededCategory()', () => {
    it('accepts every seeded pair', () => {
      for (const row of DOCUMENT_CATEGORY_SEED) {
        expect(
          isSeededCategory(row.moduleKey, row.documentKey),
          `${row.moduleKey}/${row.documentKey} rejected`,
        ).toBe(true);
      }
      expect(isSeededCategory(UNCATEGORIZED.moduleKey, UNCATEGORIZED.documentKey)).toBe(true);
    });

    it('rejects a valid documentKey under the WRONG module', () => {
      // The whole reason the check is on the pair. `pan_card` is real, and
      // `biz_tax` is real, but `biz_tax/pan_card` is not a category.
      expect(isSeededCategory('biz_tax', 'pan_card')).toBe(false);
      expect(isSeededCategory('identity', 'gst_returns')).toBe(false);
      // The retired module is gone from the seed entirely, key and all.
      expect(isSeededCategory('business', 'registration_certificate')).toBe(false);
      // ...while a genuine cross-taxonomy collision resolves under each of its
      // real modules. `pan_card` is a person's PAN under identity and a
      // company's under biz_registration — two different documents, one name.
      expect(isSeededCategory('identity', 'pan_card')).toBe(true);
      expect(isSeededCategory('biz_registration', 'pan_card')).toBe(true);
    });

    it('rejects the shapes a language model actually gets wrong', () => {
      expect(isSeededCategory('identity', 'pan')).toBe(false);         // abbreviated
      expect(isSeededCategory('Identity', 'PAN_Card')).toBe(false);    // re-cased
      expect(isSeededCategory('identity', '')).toBe(false);            // module only
      expect(isSeededCategory('identity', 'pan_card ')).toBe(false);   // trailing space
      expect(isSeededCategory('identity.pan_card', '')).toBe(false);   // pre-0012 dotted code
      // The 0015 module names must no longer resolve — 0023 moved off them, and
      // a model trained on an older prompt will still offer them.
      expect(isSeededCategory('documents', 'pan_card')).toBe(false);
      expect(isSeededCategory('lic_mediclaim', 'life_policies')).toBe(false);
      expect(isSeededCategory('corporate_compliance', 'invoices')).toBe(false);
      expect(isSeededCategory('system', 'uncategorized')).toBe(false);
      expect(isSeededCategory('documents', 'uncategorized')).toBe(false);
    });

    it('rejects legacy words, unknown pairs and non-strings', () => {
      expect(isSeededCategory('custom', 'farm_land')).toBe(false);
      for (const legacy of ['legal', 'medical', 'documents', 'trading', '_custom_']) {
        expect(isSeededCategory(legacy, legacy), `${legacy} accepted as a category`).toBe(false);
      }
      expect(isSeededCategory('', '')).toBe(false);
      expect(isSeededCategory(null, null)).toBe(false);
      expect(isSeededCategory(undefined, undefined)).toBe(false);
      expect(isSeededCategory(42, 42)).toBe(false);
    });
  });

  describe('buildAiCategoryList()', () => {
    // Scoped since 0050: a personal scan is never offered a business category
    // and vice versa. Sending both would double every prompt to offer
    // categories the account cannot file into — and would ask the model to
    // choose between two "Bank Statements" with no stated boundary.
    const personalList = buildAiCategoryList('personal');
    const businessList = buildAiCategoryList('business');
    const list = `${personalList}\n${businessList}`;

    it('defaults to the personal taxonomy', () => {
      expect(buildAiCategoryList()).toBe(personalList);
    });

    it('keeps the two taxonomies out of each other lists', () => {
      expect(personalList).not.toContain('biz_');
      expect(businessList).toContain('moduleKey: "biz_tax"');
      expect(businessList).not.toContain('moduleKey: "identity"');
    });

    it('offers every seeded documentKey to the model, except a mirror address', () => {
      for (const row of DOCUMENT_CATEGORY_SEED) {
        if (isMirrorAlias(row)) continue;
        expect(list, `${row.documentKey} missing from the AI prompt`)
          .toContain(`"${row.documentKey}"`);
      }
    });

    it('never offers a mirror alias — it is an address, not a destination', () => {
      // A mirrored category is a second way to LIST another module's records
      // (src/lib/categoryMirrors.ts). Offering it would give the model two
      // answers for one document, and half the motor policies would be filed
      // where nothing lists them. Its canonical stays in the prompt.
      for (const mirror of CATEGORY_MIRRORS) {
        expect(list, `${mirror.alias.documentKey} must not be offered as a destination`)
          .not.toContain(`"${mirror.alias.documentKey}"`);
        expect(list, `${mirror.canonical.documentKey} is where those documents go`)
          .toContain(`"${mirror.canonical.documentKey}"`);
      }
    });

    it('names the moduleKey in every heading, so the model can emit the pair', () => {
      // Without this the model sees bare documentKeys and has nothing to pair
      // them with — and `registration_certificate` alone is ambiguous.
      // `other` is deliberately absent as a numbered module — it is rendered as
      // a Fallback stanza so the model reads it as a last resort, not a peer.
      for (const m of DOCUMENT_CATEGORY_MODULES) {
        if (m.moduleKey === UNCATEGORIZED.moduleKey) {
          expect(list).not.toContain(`Module ${m.moduleNo} —`);
          continue;
        }
        expect(list).toContain(`Module ${m.moduleNo} — ${m.moduleName} (moduleKey: "${m.moduleKey}"):`);
      }
    });

    it('offers Uncategorized as an explicit escape hatch', () => {
      // Without a "none of these" option a model invents a plausible-looking
      // wrong category rather than admitting uncertainty.
      expect(list).toContain(`(moduleKey: "${UNCATEGORIZED.moduleKey}")`);
      expect(list).toContain(`"${UNCATEGORIZED.documentKey}"`);
      expect(list.toLowerCase()).toContain('fits none of the above');
    });

    it('renders every category line as - "<documentKey>": <documentName>', () => {
      // Asserted per list, not over the concatenation: the catch-all renders as
      // a Fallback stanza in BOTH lists — correctly, since a scan of either kind
      // can fail to classify — so a combined count would double it.
      for (const [scope, text] of [
        ['personal', personalList],
        ['business', businessList],
      ] as const) {
        const lines = text.split('\n').filter((l) => l.trim().startsWith('- '));
        // Every seeded row of THIS taxonomy, less the mirror addresses (which
        // are not destinations), plus the shared catch-all.
        const expected = DOCUMENT_CATEGORY_SEED.filter(
          (r) => !isMirrorAlias(r)
            && (taxonomyOf(r.moduleKey) === scope
              || r.moduleKey === UNCATEGORIZED.moduleKey),
        ).length;
        expect(lines, scope).toHaveLength(expected);
        for (const line of lines) {
          expect(line, line).toMatch(/^\s+- "[a-z][a-z0-9_]*": .+$/);
        }
      }
    });

    it('offers exactly two tiers, module then sub-category', () => {
      // 0022 briefly added a third `group` tier and 0023 deleted it. Re-adding
      // one to the prompt would cost ~600 tokens and give the model a third
      // field to get wrong, for a value the server can derive from the pair it
      // already emits.
      for (const [scope, text] of [
        ['personal', personalList],
        ['business', businessList],
      ] as const) {
        const headings = text.split('\n').filter((l) => l.includes('(moduleKey:'));
        // This taxonomy's numbered modules (the catch-all is not one of them)
        // plus the single Fallback stanza that stands in for it.
        const numbered = DOCUMENT_CATEGORY_MODULES.filter(
          (m) => taxonomyOf(m.moduleKey) === scope
            && m.moduleKey !== UNCATEGORIZED.moduleKey,
        ).length;
        expect(headings, scope).toHaveLength(numbered + 1);
        for (const line of headings) {
          expect(line, line).toMatch(/^ {3}(Module \d+ — .+|Fallback) \(moduleKey: "[a-z_]+"\):$/);
        }
      }
      // The guard is against a third TIER, not against the word: `biz_insurance`
      // legitimately offers "Employee Group Insurance". A tier would have to
      // appear as a key in a heading, the way `moduleKey:` does.
      expect(list).not.toMatch(/groupKey:/i);
      expect(list).not.toMatch(/^\s*Group \d+/im);
    });

    it('survives the AI privacy masker untouched', () => {
      // The system prompt is passed through maskSensitiveText on every call
      // (src/lib/ai.js). If a category name ever contains an email, a 9+ digit
      // run, or a PAN-shaped token, the masker silently rewrites the prompt and
      // the model is told to emit a code that no longer exists.
      expect(maskSensitiveText(list)).toBe(list);
    });
  });

  describe('Retired-category reap (drizzle/0036)', () => {
    const sql = readFileSync(REAP_PATH, 'utf8');
    const del = sql.indexOf('DELETE FROM "document_categories"');

    it('deletes by predicate, not by id', () => {
      // Category ids are generated at migration time and differ per
      // environment: a hard-coded list would delete nothing in one database and
      // the wrong rows in another.
      expect(del).toBeGreaterThan(-1);
      expect(sql).toMatch(/DELETE FROM "document_categories" WHERE "is_active" = false/);
      expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });

    it('guards all three reference classes BEFORE deleting', () => {
      // A guard after the delete asserts nothing. Each of these is a class of
      // reference that nothing else in the database would catch.
      for (const [what, needle] of [
        ['documents', 'reference a retired category'],
        ['encrypt policies', 'still belong to a retired category'],
        ['permissions', 'grant access to a retired category'],
      ] as const) {
        const at = sql.indexOf(needle);
        expect(at, `no guard for ${what}`).toBeGreaterThan(-1);
        expect(at, `the ${what} guard runs after the delete`).toBeLessThan(del);
      }
    });

    it('counts soft-deleted documents as references', () => {
      // A tombstoned document is restorable, so its category must survive too.
      const guard = sql.slice(0, del);
      expect(guard).toContain('FROM "documents" d');
      expect(guard).not.toMatch(/deleted_at" IS NULL/);
      // The denormalised pair is checked beside the FK.
      expect(guard).toContain('"category_module_key"');
      expect(guard).toContain('"category_document_key"');
    });

    it('guards the CASCADE rather than relying on 0035 having run', () => {
      // document_category_fields.category_id is ON DELETE CASCADE — without
      // this guard the delete would take an encrypt policy with it, silently.
      expect(sql).toContain('run 0035 first');
      expect(sql.indexOf('"document_category_fields" f')).toBeLessThan(del);
    });

    it('matches permissions on the PAIR, not the module alone', () => {
      // `tax_compliance` and `utility_bills` survived 0023 as live module keys,
      // so a module-wide grant on either is valid — only a grant naming the
      // retired sub-category is not.
      expect(sql).toMatch(/\("?p"?\."module", "?p"?\."document_key"\) IN/);
    });

    it('asserts the table is the live taxonomy afterwards', () => {
      const check = sql.indexOf('retired rows survived the delete');
      expect(check).toBeGreaterThan(del);
      expect(sql).toContain('RAISE EXCEPTION');
    });

    it('deletes from no other table', () => {
      // The cascade is guarded against, never leant on.
      const deletes = sql.match(/DELETE FROM "(\w+)"/g) ?? [];
      expect(deletes).toEqual(['DELETE FROM "document_categories"']);
    });
  });

  describe('Personal business module drop (drizzle/0055)', () => {
    const sql = readFileSync(DROP_BUSINESS_PATH, 'utf8');
    const del = sql.indexOf('DELETE FROM "document_categories"');

    it('deletes the module by key, and only that module', () => {
      expect(del).toBeGreaterThan(-1);
      expect(sql).toMatch(
        /DELETE FROM "document_categories" WHERE "module_key" = 'business'/);
      // One module named, no id list, and nothing that could widen the predicate.
      expect(sql.match(/DELETE FROM "document_categories"[^;]*/g)).toHaveLength(1);
      expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });

    it('refuses BEFORE deleting if anything still points at the module', () => {
      // Four reference classes, all checked ahead of the delete. A guard that
      // runs afterwards asserts nothing.
      for (const [what, needle] of [
        ['documents by FK', 'are filed under the business module'],
        ['the denormalised pair', 'carry the denormalised business category key'],
        ['vault stores', 'vault stores are keyed to the business module'],
        ['passwords', 'passwords are keyed to the business module'],
      ] as const) {
        const at = sql.indexOf(needle);
        expect(at, `no guard for ${what}`).toBeGreaterThan(-1);
        expect(at, `the ${what} guard runs after the delete`).toBeLessThan(del);
      }
      expect(sql).toContain('RAISE EXCEPTION');
    });

    it('counts soft-deleted documents as references', () => {
      // Same rule as 0036: a tombstoned document is restorable, so the category
      // it points at may not be deleted out from under it.
      expect(sql.slice(0, del)).not.toMatch(/deleted_at/);
    });

    it('clears the permission grants nothing else can reach', () => {
      // `business` is not in PERMISSION_MODULE_KEYS, so the matrix cannot show
      // these rows and no screen can revoke them. Unlike 0036, the module key
      // itself is dead, so matching the module alone is right here.
      expect(sql).toMatch(/DELETE FROM "permissions" WHERE "module" = 'business'/);
    });

    it('touches no table but those two', () => {
      const deletes = sql.match(/DELETE FROM "(\w+)"/g) ?? [];
      expect(deletes).toEqual([
        'DELETE FROM "document_categories"',
        'DELETE FROM "permissions"',
      ]);
    });

    it('proves the taxonomy is intact afterwards', () => {
      // The field specs SHOULD cascade away with the module — they are its spec.
      // What must not happen is a surviving category losing its own.
      const check = sql.indexOf('categories lost their field spec');
      expect(check).toBeGreaterThan(del);
      expect(sql.indexOf('business categories survived the delete')).toBeGreaterThan(del);
    });

    it('is in the journal, after 0054', () => {
      // Its POSITION, not its lastness. `at(-1)` was the same assertion for as
      // long as 0055 happened to be the newest migration, and then it failed
      // for the next one that was added — which says nothing about this one.
      // What must hold is the ordering the header of 0055 depends on.
      const journal = JSON.parse(readFileSync(
        join(__dirname, '..', 'drizzle', 'meta', '_journal.json'), 'utf8'));
      const tags = journal.entries.map((e: { tag: string }) => e.tag);
      const here = tags.indexOf('0055_drop_retired_business_module');
      expect(here).toBeGreaterThan(-1);
      expect(here).toBe(tags.indexOf('0054_company_scoped_analysis_cache') + 1);
    });
  });

});
