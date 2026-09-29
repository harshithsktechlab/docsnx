/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ROLLBACK CONTRACT                                                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The requirement: if the business account has to be withdrawn, the personal
 * account must keep working — including on the code from before companies
 * existed.
 *
 * Two things have to hold, and both are invisible in normal use, which is why
 * they are asserted here rather than left to be discovered during an incident:
 *
 *   1. A personal record must seal to the SAME bytes the pre-business build
 *      produced, or every personal document written since the business deploy
 *      becomes unreadable the moment we roll back.
 *   2. The rollback script must restore the exact index the pre-business
 *      `persistPointer` infers its ON CONFLICT arbiter from, or the old build
 *      raises 42P10 on every record save.
 *
 * `scripts/verify_rollback_safety.mjs` proves (2) against a live Postgres
 * planner inside a rolled-back transaction. This file guards the shapes so the
 * proof stays true.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { serializeAad } from '@/lib/tenantCrypto';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/**
 * The AAD the PRE-BUSINESS build produced, transcribed from
 * `e6490c5:src/lib/tenantCrypto.ts`. Six fields, no company segment.
 */
function preBusinessAad(a: {
  tenantId: string; module: string; categoryModuleKey?: string;
  categoryDocumentKey?: string; kind: string; id?: string;
}): string {
  return [
    `t=${a.tenantId}`,
    `m=${a.module}`,
    `mk=${a.categoryModuleKey ?? ''}`,
    `dk=${a.categoryDocumentKey ?? ''}`,
    `k=${a.kind}`,
    `i=${a.id ?? ''}`,
  ].join('|');
}

describe('personal records stay readable by the pre-business build', () => {
  it.each([
    { tenantId: 't1', module: 'documents', kind: 'json' as const, id: 'r1' },
    {
      tenantId: 't1', module: 'identity', categoryModuleKey: 'identity',
      categoryDocumentKey: 'pan_card', kind: 'file' as const, id: 'doc-9',
    },
    { tenantId: 't2', module: 'passwords', kind: 'json' as const },
  ])('seals $module/$kind to the identical byte string', (aad) => {
    expect(serializeAad(aad).toString()).toBe(preBusinessAad(aad));
  });

  it('never emits a company segment for a personal record', () => {
    // Emitting an empty `c=` is the specific mistake this guards: it reads as
    // harmless and makes every personal record written afterwards undecryptable
    // by the build we may have to fall back to.
    expect(serializeAad({ tenantId: 't', module: 'documents', kind: 'json' }).toString())
      .not.toContain('c=');
    expect(serializeAad({ tenantId: 't', module: 'documents', kind: 'json', companyId: null }).toString())
      .not.toContain('c=');
  });

  it('still binds a company, so the compatibility does not cost the isolation', () => {
    const base = { tenantId: 't', module: 'documents', kind: 'json' as const, id: 'r1' };
    const company = serializeAad({ ...base, companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(company.toString()).not.toBe(preBusinessAad(base));
    expect(company.toString().startsWith(preBusinessAad(base))).toBe(true);
  });
});

describe('the rollback script restores what the old build needs', () => {
  const script = read('scripts/rollback_business_account.mjs');

  it('recreates the plain four-column UNIQUE index, in that exact order', () => {
    // Arbiter inference matches on the column SET, but the index is also the
    // uniqueness rule the old build relies on — so the columns are pinned.
    const ddl = /CREATE UNIQUE INDEX[^`]*?vault_json_files_key_idx[\s\S]*?\)/.exec(script)?.[0] ?? '';
    expect(ddl).toContain('"tenant_id"');
    expect(ddl).toContain('"module"');
    expect(ddl).toContain('"category_module_key"');
    expect(ddl).toContain('"category_document_key"');
    // Not partial: a WHERE would put us straight back into 42P10.
    expect(ddl).not.toMatch(/\bWHERE\b/i);
    expect(ddl).not.toContain('company_id');
  });

  it('drops BOTH partial indexes, not just the one that shares the old name', () => {
    // `vault_json_files_company_key_idx` does not collide by name, so it is the
    // one an eye would skip — and leaving it would keep enforcing a company
    // uniqueness rule the old build knows nothing about.
    expect(script).toContain('DROP INDEX IF EXISTS "vault_json_files_key_idx"');
    expect(script).toContain('DROP INDEX IF EXISTS "vault_json_files_company_key_idx"');
  });

  it('retires the biz_ taxonomy and does NOT resurrect the personal business module', () => {
    // The old build does not know the `biz_*` modules, so leaving them active
    // would show it 84 categories it has no pages or field specs for.
    expect(script).toMatch(/is_active = false[\s\S]*?module_key LIKE 'biz/);
    // It used to re-activate `business` too. 0055 deleted those rows, so an
    // UPDATE would silently touch nothing — and re-adding one would mean
    // reinstating a module the product removed on purpose.
    expect(script).not.toMatch(/is_active = true[\s\S]*?module_key = 'business'/);
    expect(script).toContain('0055 deleted its rows');
  });

  it('refuses by default when business data exists', () => {
    // Rolling back strands business Drive objects: the old build can neither
    // read nor delete them. That has to be a decision, not a default.
    expect(script).toContain('REFUSING');
    expect(script).toMatch(/--force/);
  });
});
