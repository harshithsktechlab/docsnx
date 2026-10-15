/**
 * The member's label under Others (drizzle/0068) — see
 * src/lib/records/customSubcategory.ts. A display string, never a category.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { documents } from '@/db/schema';
import {
  CUSTOM_SUBCATEGORY_MAX,
  categoryDisplayName,
  customSubcategoryError,
  labelForCategory,
  readCustomSubcategory,
} from '@/lib/records/customSubcategory';

const ROOT = path.join(__dirname, '..');
const OTHERS = { moduleKey: 'other', documentKey: 'uncategorized', documentName: 'Others' };
const BIZ_OTHERS = { moduleKey: 'biz_other', documentKey: 'uncategorized', documentName: 'Others' };
const PAN = { moduleKey: 'identity', documentKey: 'pan_card', documentName: 'PAN Card' };

describe('readCustomSubcategory', () => {
  it('keeps "not sent" apart from "sent blank"', () => {
    expect(readCustomSubcategory(undefined)).toBeUndefined();
    expect(readCustomSubcategory(null)).toBeNull();
    expect(readCustomSubcategory('')).toBeNull();
    expect(readCustomSubcategory('   ')).toBeNull();
  });

  it('trims, collapses whitespace and strips control characters', () => {
    expect(readCustomSubcategory('  Gym\t\tMembership \n')).toBe('Gym Membership');
    expect(readCustomSubcategory('Gym\u0000Card')).toBe('Gym Card');
  });

  it('ignores a value that is not text', () => {
    expect(readCustomSubcategory(42)).toBeUndefined();
  });
});

describe('customSubcategoryError', () => {
  it('refuses a label over the column width only', () => {
    expect(customSubcategoryError('x'.repeat(CUSTOM_SUBCATEGORY_MAX))).toBeNull();
    expect(customSubcategoryError('x'.repeat(CUSTOM_SUBCATEGORY_MAX + 1))).toMatch(/120/);
    expect(customSubcategoryError(null)).toBeNull();
  });
});

describe('labelForCategory', () => {
  it('keeps the label under either catch-all', () => {
    expect(labelForCategory(OTHERS, 'Gym Membership')).toBe('Gym Membership');
    expect(labelForCategory(BIZ_OTHERS, 'Trade fair pass')).toBe('Trade fair pass');
    expect(labelForCategory(OTHERS, undefined)).toBeUndefined();
  });

  it('answers null for a real category, which is what clears it on a move', () => {
    expect(labelForCategory(PAN, 'Gym Membership')).toBeNull();
    expect(labelForCategory(PAN, undefined)).toBeNull();
    expect(labelForCategory(null, 'x')).toBeNull();
  });
});

describe('categoryDisplayName', () => {
  it('shows the label under Others and the category name everywhere else', () => {
    expect(categoryDisplayName(OTHERS, 'Gym Membership')).toBe('Gym Membership');
    expect(categoryDisplayName(OTHERS, null)).toBe('Others');
    expect(categoryDisplayName(PAN, 'stray')).toBe('PAN Card');
  });
});

describe('the 0068 migration', () => {
  it('adds the column additively and is journalled', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'drizzle/0068_document_custom_subcategory.sql'), 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "custom_subcategory" varchar\(120\)/);
    const journal = JSON.parse(fs.readFileSync(path.join(ROOT, 'drizzle/meta/_journal.json'), 'utf8'));
    expect(journal.entries.map((e: { tag: string }) => e.tag)).toContain('0068_document_custom_subcategory');
  });

  it('is mirrored in the Drizzle schema', () => {
    expect(getTableColumns(documents).customSubcategory?.name).toBe('custom_subcategory');
  });
});
