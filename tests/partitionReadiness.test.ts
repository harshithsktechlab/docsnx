import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   `documents` AND `passwords` MUST STAY PARTITIONABLE                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The business account was deliberately built on the SAME record tables rather
 * than on a fork of them (see the header of drizzle/0050_business_accounts.sql).
 * That decision rests on partitioning being available later as a pure DDL
 * change:
 *
 *   documents PARTITION BY LIST (account_scope)
 *     -> documents_personal / documents_business, each HASH (tenant_id)
 *
 * Postgres imposes two structural conditions on getting there, and both hold
 * today. Neither is visible in any other test, and breaking either is a one-line
 * change that looks completely innocent — an `id` foreign key is the most
 * ordinary thing in the world to add.
 *
 * If a future change genuinely needs one of these, that is a decision to take
 * deliberately: it means giving up cheap partitioning, and the fix is to argue
 * it here rather than to delete the assertion.
 *
 *   1. NOTHING MAY TAKE A FOREIGN KEY ONTO documents.id / passwords.id.
 *      A partitioned table can only be referenced on a key that includes the
 *      partition key, so `references(() => documents.id)` alone would have to be
 *      rewritten — across every referencing table — at partition time.
 *      `audit_logs` already models the right pattern: it stores `entity_id` with
 *      no FK at all, on purpose, so an audit row outlives the record it
 *      describes.
 *
 *   2. EVERY UNIQUE INDEX MUST INCLUDE tenant_id.
 *      Postgres requires a unique constraint on a partitioned table to contain
 *      the partition key. A unique index over, say, (source_hash) alone could
 *      not be recreated after partitioning.
 *
 * Pure — reads the schema source, no DB.
 */

const SCHEMA_PATH = path.join(__dirname, '..', 'src', 'db', 'schema.ts');
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');

/** The tables the business account shares, and which therefore must stay split-able. */
const PARTITIONABLE = ['documents', 'passwords'] as const;

describe('partition readiness of the shared record tables', () => {
  it.each(PARTITIONABLE)('nothing holds a foreign key onto %s.id', (table) => {
    // Drizzle spells an FK as `references(() => <table>.id, …)`. Whitespace is
    // normalised first so a reformat cannot smuggle one past the match.
    const flat = schema.replace(/\s+/g, ' ');
    const pattern = new RegExp(String.raw`references\(\s*\(\)\s*=>\s*${table}\.id`, 'g');
    const hits = flat.match(pattern) ?? [];
    expect(
      hits,
      `something now references ${table}.id — see this file's header before removing this assertion`,
    ).toEqual([]);
  });

  it.each(PARTITIONABLE)('every unique index on %s includes tenant_id', (table) => {
    // Isolate the table's own pgTable(...) block: everything from its
    // declaration to the start of the next top-level export.
    const start = schema.indexOf(`export const ${table} = pgTable(`);
    expect(start, `${table} not found in the schema`).toBeGreaterThan(-1);
    const after = schema.indexOf('\nexport const ', start + 1);
    const block = schema.slice(start, after === -1 ? undefined : after);

    // Each `uniqueIndex("name")` and the `.on(...)` chain that follows it.
    const uniques = Array.from(
      block.matchAll(/uniqueIndex\(\s*["'`]([^"'`]+)["'`]\s*\)([\s\S]*?)(?=\n\s{4}\w|\n\s{2}\}\)|$)/g),
    );

    for (const [, name, body] of uniques) {
      expect(
        /tenantId|tenant_id/.test(body),
        `unique index ${name} on ${table} omits tenant_id, which blocks partitioning`,
      ).toBe(true);
    }
  });

  it('keeps account_scope stored and NOT NULL — a partition key cannot be an expression', () => {
    // `company_id IS NULL` would express the same thing and cannot be a
    // partition key: Postgres needs a real, NOT NULL column. This is the whole
    // reason the redundant column exists, so a well-meaning cleanup that drops
    // it should fail here.
    for (const table of PARTITIONABLE) {
      const start = schema.indexOf(`export const ${table} = pgTable(`);
      const after = schema.indexOf('\nexport const ', start + 1);
      const block = schema.slice(start, after === -1 ? undefined : after);
      expect(block, `${table} lost account_scope`).toMatch(
        /accountScope: varchar\("account_scope", \{ length: 16 \}\)\.default\('personal'\)\.notNull\(\)/,
      );
    }
  });

  it('states both invariants in the migration that relies on them', () => {
    // The migration explains WHY the tables were shared rather than forked. If
    // that reasoning is ever removed, this test is arguing for nothing.
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'drizzle', '0050_business_accounts.sql'),
      'utf8',
    );
    expect(sql).toContain('foreign key onto `documents.id`');
    expect(sql).toContain('every unique index must include');
  });
});
