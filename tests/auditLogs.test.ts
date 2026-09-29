import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ACTIONS,
  parseAuditAction,
  auditActionVariant,
  auditSentence,
  categoryPhrase,
  formatAuditAction,
} from '@/lib/auditActions';

/**
 * Audit Logs module tests.
 *
 * These are pure unit tests: `@/lib/db` is mocked, so nothing here opens a
 * connection. Do NOT add tests that hit a live server — localhost:3005 is
 * production on this host.
 */

// Hoisted so the vi.mock factory below can close over it.
const { dbState } = vi.hoisted(() => ({
  dbState: { rows: [] as any[], fail: false },
}));

vi.mock('@/lib/db', () => ({
  db: {
    insert: () => ({
      values: async (v: any) => {
        if (dbState.fail) throw new Error('insert failed');
        dbState.rows.push(v);
        return undefined;
      },
    }),
  },
}));

// Imported after the mock so writeAudit binds to the fake db.
const { writeAudit } = await import('@/lib/audit');

/** A transaction-like executor: distinct from `db`, so errors must propagate. */
function fakeTx(rows: any[], fail = false) {
  return {
    insert: () => ({
      values: async (v: any) => {
        if (fail) throw new Error('tx insert failed');
        rows.push(v);
      },
    }),
  } as any;
}

function reqWith(headers: Record<string, string>): Request {
  return new Request('https://docsnx.com/api/documents', { headers });
}

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const DOC = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  dbState.rows = [];
  dbState.fail = false;
});

describe('parseAuditAction', () => {
  it('splits the canonical <entity>.<verb> form', () => {
    expect(parseAuditAction('document.create')).toEqual({ entity: 'document', verb: 'create' });
  });

  it('understands legacy verb-first SCREAMING_SNAKE', () => {
    expect(parseAuditAction('CREATE_DOCUMENT')).toEqual({ entity: 'document', verb: 'create' });
    expect(parseAuditAction('DELETE_MEDICAL_RECORD')).toEqual({
      entity: 'medical_record',
      verb: 'delete',
    });
  });

  it('understands legacy noun-first past tense', () => {
    expect(parseAuditAction('TAX_COMPLIANCE_CREATED')).toEqual({
      entity: 'tax_compliance',
      verb: 'create',
    });
    expect(parseAuditAction('GOOGLE_DRIVE_DISCONNECTED')).toEqual({
      entity: 'google_drive',
      verb: 'disconnect',
    });
  });

  it('normalises the legacy _REVEALED spellings onto the `view` verb', () => {
    // One per module before `<module>.view` existed. Historical rows are never
    // rewritten, so this is the only thing that keeps them readable.
    expect(parseAuditAction('TAX_COMPLIANCE_REVEALED')).toEqual({
      entity: 'tax_compliance',
      verb: 'view',
    });
    expect(parseAuditAction('PASSWORD_REVEALED')).toEqual({ entity: 'password', verb: 'view' });
  });

  it('understands legacy dot-case with a multi-word verb', () => {
    expect(parseAuditAction('payment.edit_manual')).toEqual({
      entity: 'payment',
      verb: 'edit_manual',
    });
  });

  it('never throws on unrecognised or empty input', () => {
    expect(parseAuditAction('WHAT_IS_THIS')).toEqual({ entity: 'what_is_this', verb: '' });
    expect(parseAuditAction('')).toEqual({ entity: '', verb: '' });
  });
});

describe('auditActionVariant', () => {
  it('colours canonical actions by verb', () => {
    expect(auditActionVariant(ACTIONS.documents.create)).toBe('success');
    expect(auditActionVariant(ACTIONS.documents.update)).toBe('secondary');
    expect(auditActionVariant(ACTIONS.documents.delete)).toBe('destructive');
  });

  it('colours legacy rows identically, so history still reads correctly', () => {
    expect(auditActionVariant('CREATE_DOCUMENT')).toBe('success');
    expect(auditActionVariant('UPDATE_DOCUMENT')).toBe('secondary');
    expect(auditActionVariant('WILLS_ESTATE_DELETED')).toBe('destructive');
  });

  it('classifies verbs the old substring matcher missed entirely', () => {
    // The previous UI only looked for CREATE / UPDATE / DELETE, so these all
    // fell through to the neutral 'outline' badge.
    expect(auditActionVariant('DEACTIVATE_ADDON')).toBe('destructive');
    expect(auditActionVariant('GOOGLE_DRIVE_GRANT_REVOKED')).toBe('destructive');
    expect(auditActionVariant('REGISTER_TENANT')).toBe('success');
  });

  it('colours a reveal the same whether it is canonical or legacy', () => {
    expect(auditActionVariant('tax_compliance.view')).toBe('secondary');
    expect(auditActionVariant('TAX_COMPLIANCE_REVEALED')).toBe('secondary');
  });

  it('falls back to outline for unknown verbs', () => {
    expect(auditActionVariant('SOMETHING_UNMAPPED')).toBe('outline');
  });
});

describe('formatAuditAction', () => {
  it('renders a past-tense label, not the raw verb', () => {
    // The badge used to read "DOCUMENTS CREATE" beside "TAX COMPLIANCE CREATE".
    expect(formatAuditAction('documents.create')).toBe('Documents Added');
    expect(formatAuditAction('documents.delete')).toBe('Documents Deleted');
    expect(formatAuditAction('tax_compliance.create')).toBe('Tax & Compliance Added');
  });

  it('labels legacy rows with the SAME words as canonical ones', () => {
    // A tenant with history sees both spellings in the filter dropdown; they
    // must at least read identically.
    expect(formatAuditAction('CREATE_MEDICAL_RECORD')).toBe('Medical Added');
    expect(formatAuditAction('TAX_COMPLIANCE_REVEALED')).toBe('Tax & Compliance Viewed');
  });

  it('falls back to a title-cased key for an entity it was never told about', () => {
    expect(formatAuditAction('some_new_thing.create')).toBe('Some New Thing Added');
  });
});

describe('auditSentence', () => {
  it('names the record, its category and the member it is filed under', () => {
    expect(auditSentence('create', {
      kind: 'document',
      name: 'CGHPK9369M_PARTB_2025-26',
      category: 'ITR filings and Form 16',
      member: 'Arjun Krishnan',
    })).toBe(
      'Added document "CGHPK9369M_PARTB_2025-26" to ITR filings and Form 16 for Arjun Krishnan.'
    );
  });

  it('names the member on every verb, not just create', () => {
    // "Deleted document 'FORM NO. 16 PART B'." could not answer whose it was.
    expect(auditSentence('delete', {
      kind: 'document', name: 'Form 16', category: 'ITR filings and Form 16',
      member: 'Arjun Krishnan',
    })).toBe('Deleted document "Form 16" from ITR filings and Form 16 for Arjun Krishnan.');

    expect(auditSentence('bulk_export', {
      kind: 'document', name: 'Form 16', category: 'ITR filings and Form 16',
      member: 'Arjun Krishnan', note: 'one of 2 downloaded together as a ZIP archive',
    })).toBe(
      'Downloaded document "Form 16" from ITR filings and Form 16 for Arjun Krishnan'
      + ' \u2014 one of 2 downloaded together as a ZIP archive.'
    );
  });

  it('reads an export as a removal — the bytes left the vault', () => {
    expect(auditSentence('bulk_export', { kind: 'document', name: 'x', category: 'PAN Card' }))
      .toContain('from PAN Card');
  });

  it('swaps the preposition so a delete reads as removal', () => {
    expect(auditSentence('delete', {
      kind: 'document', name: 'Form 16', category: 'ITR filings and Form 16',
    })).toBe('Deleted document "Form 16" from ITR filings and Form 16.');
  });

  it('drops every absent clause rather than leaving a dangling preposition', () => {
    expect(auditSentence('delete', { kind: 'password', name: 'HDFC Netbanking' }))
      .toBe('Deleted password "HDFC Netbanking".');
    expect(auditSentence('sync', { kind: '14 modules' })).toBe('Synced 14 modules.');
  });

  it('appends a note after an em dash, inside the sentence', () => {
    expect(auditSentence('update', { kind: 'record', name: 'PAN', note: 'replaced the attached file' }))
      .toBe('Updated record "PAN" — replaced the attached file.');
  });

  it('never lets a quote in a title close the quoted field early', () => {
    expect(auditSentence('create', { kind: 'document', name: 'The "Big" File' }))
      .toBe('Added document "The ”Big” File".');
  });
});

describe('categoryPhrase', () => {
  it('renders the display name, never the taxonomy pair', () => {
    expect(categoryPhrase('bank_investments', 'itr_form16')).toBe('ITR filings and Form 16');
  });

  it('degrades to a title-cased key for a pair that is not seeded', () => {
    expect(categoryPhrase('made_up', 'some_key')).toBe('Some Key');
  });

  it('returns null when there is no category to name', () => {
    expect(categoryPhrase(null, null)).toBeNull();
    expect(categoryPhrase('identity', null)).toBeNull();
  });
});

describe('ACTIONS vocabulary', () => {
  const leaves: string[] = [];
  for (const group of Object.values(ACTIONS)) {
    for (const value of Object.values(group as Record<string, string>)) {
      leaves.push(value);
    }
  }

  it('is non-empty and every value is canonical <entity>.<verb> dot-case', () => {
    expect(leaves.length).toBeGreaterThan(50);
    for (const a of leaves) {
      expect(a, a).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });

  it('has no duplicate action strings', () => {
    expect(new Set(leaves).size).toBe(leaves.length);
  });

  it('round-trips through parseAuditAction', () => {
    for (const a of leaves) {
      const { entity, verb } = parseAuditAction(a);
      expect(`${entity}.${verb}`, a).toBe(a);
    }
  });

  it('fits the action varchar(255) column', () => {
    for (const a of leaves) {
      expect(a.length, a).toBeLessThanOrEqual(255);
    }
  });
});

describe('writeAudit', () => {
  it('records the client IP and user agent from the request', async () => {
    await writeAudit({
      tenantId: TENANT,
      userId: USER,
      action: ACTIONS.documents.create,
      details: "Uploaded document 'Aadhaar'.",
      entityType: 'documents',
      entityId: DOC,
      req: reqWith({
        'cf-connecting-ip': '203.0.113.9',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)',
      }),
    });

    expect(dbState.rows).toHaveLength(1);
    expect(dbState.rows[0]).toMatchObject({
      tenantId: TENANT,
      userId: USER,
      action: 'documents.create',
      entityType: 'documents',
      entityId: DOC,
      ipAddress: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    });
  });

  it('takes tenantId from the entry, never from request headers', async () => {
    const attackerTenant = '99999999-9999-9999-9999-999999999999';

    await writeAudit({
      tenantId: TENANT,
      action: ACTIONS.documents.delete,
      details: 'Deleted document.',
      req: reqWith({ 'x-tenant-id': attackerTenant, 'cf-connecting-ip': '203.0.113.9' }),
    });

    expect(dbState.rows[0].tenantId).toBe(TENANT);
    expect(JSON.stringify(dbState.rows[0])).not.toContain(attackerTenant);
  });

  it('truncates a user agent to the varchar(500) column width', async () => {
    await writeAudit({
      tenantId: TENANT,
      action: ACTIONS.documents.create,
      details: 'x',
      req: reqWith({ 'user-agent': 'A'.repeat(900) }),
    });

    expect(dbState.rows[0].userAgent).toHaveLength(500);
  });

  it('leaves ip and user agent null for events with no request', async () => {
    await writeAudit({
      tenantId: TENANT,
      action: ACTIONS.payment.capture_webhook,
      details: 'Webhook captured payment.',
    });

    expect(dbState.rows[0].ipAddress).toBeNull();
    expect(dbState.rows[0].userAgent).toBeNull();
  });

  it('normalises omitted optional fields to null rather than undefined', async () => {
    await writeAudit({ tenantId: TENANT, action: ACTIONS.backup.restore, details: 'Restored.' });

    expect(dbState.rows[0]).toMatchObject({
      userId: null,
      resource: null,
      entityType: null,
      entityId: null,
    });
  });

  it('truncates over-long action, resource and entityType values', async () => {
    await writeAudit({
      tenantId: TENANT,
      action: 'a'.repeat(300),
      resource: 'b'.repeat(300),
      entityType: 'c'.repeat(200),
      details: 'x',
    });

    expect(dbState.rows[0].action).toHaveLength(255);
    expect(dbState.rows[0].resource).toHaveLength(255);
    expect(dbState.rows[0].entityType).toHaveLength(100);
  });

  it('rejects a missing tenantId instead of writing an unscoped row', async () => {
    await expect(
      writeAudit({ tenantId: '', action: ACTIONS.documents.create, details: 'x' })
    ).rejects.toThrow(/tenantId is required/);

    expect(dbState.rows).toHaveLength(0);
  });

  it('writes through the transaction when one is passed', async () => {
    const txRows: any[] = [];

    await writeAudit(
      { tenantId: TENANT, action: ACTIONS.password.create, details: 'Saved credential.' },
      fakeTx(txRows)
    );

    // Must go to the tx, not the pool, or the row is not atomic with the mutation.
    expect(txRows).toHaveLength(1);
    expect(dbState.rows).toHaveLength(0);
  });

  it('propagates failures inside a transaction so the mutation rolls back', async () => {
    await expect(
      writeAudit(
        { tenantId: TENANT, action: ACTIONS.password.create, details: 'x' },
        fakeTx([], true)
      )
    ).rejects.toThrow(/tx insert failed/);
  });

  it('swallows failures outside a transaction so a committed mutation still succeeds', async () => {
    dbState.fail = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      writeAudit({ tenantId: TENANT, action: ACTIONS.documents.create, details: 'x' })
    ).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('audit logs navigation', () => {
  it('guards /audit-logs against SUPER_ADMIN', async () => {
    // The trail is tenant-owned: hasPermission() denies the platform role and
    // /api/audit-logs hard-gates on TENANT_ADMIN. The client-side guard in
    // Shell.js reads this list, so a missing entry lets SUPER_ADMIN open the
    // page and sit in front of a 403 instead of being redirected to /tenants.
    const { TENANT_SPECIFIC_PATHS } = await import('@/lib/moduleRegistry');
    expect(TENANT_SPECIFIC_PATHS).toContain('/audit-logs');
  });

  it('keeps audit_logs a permission key now that it has a sidebar entry', async () => {
    // The Account nav group is TENANT_ADMIN-only, but the API still calls
    // hasPermission(user, 'audit_logs', 'view') — which returns false for every
    // STANDARD user if the key is ever dropped from the registry.
    const { PERMISSION_MODULE_KEYS } = await import('@/lib/moduleRegistry');
    expect(PERMISSION_MODULE_KEYS).toContain('audit_logs');
  });
});
