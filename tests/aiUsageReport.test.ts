// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The super admin AI Usage report's pure parts: reading filters off a URL,
 * turning them into a WHERE clause with every value bound (never spliced into
 * the SQL text), and the CSV export. The queries themselves run against
 * Postgres and are exercised on the dev database, not here.
 */
vi.mock('../src/lib/db', () => ({ db: { execute: vi.fn() } }));

const dialect = new PgDialect();
const render = (q: any) => dialect.sqlToQuery(q);

describe('readFilters', () => {
  it('keeps well-formed values and drops the rest', async () => {
    const { readFilters } = await import('../src/lib/aiUsageReport');
    const f = readFilters(new URLSearchParams({
      from: '2026-10-01', to: 'yesterday',
      tenantId: '11111111-1111-4111-8111-111111111111', userId: 'not-a-uuid',
      companyId: 'household', action: 'FIELD_READ', linked: 'maybe',
    }));
    expect(f).toMatchObject({
      from: '2026-10-01', to: null,
      tenantId: '11111111-1111-4111-8111-111111111111', userId: null,
      companyId: 'household', action: 'FIELD_READ', linked: null,
    });
  });
});

describe('whereFor', () => {
  it('binds every value as a parameter', async () => {
    const { whereFor } = await import('../src/lib/aiUsageReport');
    const evil = "x'; DROP TABLE tenants; --";
    const q = render(whereFor({ model: evil, action: 'BULK_SCAN', from: '2026-10-01', to: '2026-10-19' }));
    expect(q.sql).not.toContain('DROP TABLE');
    expect(q.params).toEqual(expect.arrayContaining([evil, 'BULK_SCAN', '2026-10-01', '2026-10-19']));
    // IST day boundaries, end exclusive of the next day.
    expect(q.sql).toContain("AT TIME ZONE 'Asia/Kolkata'");
    expect(q.sql).toContain('+ 1');
  });

  it('maps the special values to NULL checks', async () => {
    const { whereFor } = await import('../src/lib/aiUsageReport');
    const q = render(whereFor({ companyId: 'household', action: 'NONE' }));
    expect(q.sql).toContain('u.company_id IS NULL');
    expect(q.sql).toContain('u.action IS NULL');
    expect(q.params).toEqual([]);
  });

  it('defines "not saved" as a linkable call from the attribution era with no record', async () => {
    const { whereFor } = await import('../src/lib/aiUsageReport');
    const q = render(whereFor({ linked: 'not_saved' }));
    expect(q.sql).toContain('u.cost_multiplier IS NOT NULL');
    expect(q.sql).toContain("('FIELD_READ', 'DOC_CLASSIFY')");
    expect(q.sql).toContain('NOT (u.document_id IS NOT NULL OR u.todo_id IS NOT NULL OR u.contact_id IS NOT NULL)');
  });

  it('is a valid condition with no filters at all', async () => {
    const { whereFor } = await import('../src/lib/aiUsageReport');
    expect(render(whereFor({})).sql).toBe('TRUE');
  });
});

describe('toCsv', () => {
  it('quotes, escapes, prefixes a BOM, and defuses formula injection', async () => {
    const { toCsv } = await import('../src/lib/aiUsageReport');
    const csv = toCsv(
      [{ a: 'Ravi, Kumar', b: 'say "hi"', c: '=HYPERLINK("x")', d: -12.5, e: null }],
      [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }, { key: 'd', label: 'D' }, { key: 'e', label: 'E' }],
    );
    expect(csv.startsWith('﻿')).toBe(true);
    const [, row] = csv.slice(1).split('\r\n');
    expect(row).toBe('"Ravi, Kumar","say ""hi""","\'=HYPERLINK(""x"")",-12.5,');
  });
});

describe('formatInr', () => {
  it('uses Indian grouping and keeps paise visible on tiny amounts', async () => {
    const { formatInr, formatCount } = await import('../src/lib/formatInr');
    expect(formatInr(123456.789)).toBe('₹1,23,456.79');
    expect(formatInr(0.0042)).toBe('₹0.0042');
    expect(formatInr(0)).toBe('₹0.00');
    expect(formatCount(1234567)).toBe('12,34,567');
  });
});
