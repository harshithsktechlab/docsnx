/**
 * Guards on how a document's fields reach the client.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * A record lives in the tenant's encrypted store on Drive; `loadRecords` opens
 * that store and hands the entry to this module, which shapes it into the
 * `{ open, masked }` envelope every Documents page reads through `docField()`.
 *
 * Postgres used to keep a copy of those two tiers in a `documents.metadata`
 * column, and this module used to read either that copy or an older camelCase
 * variant of it. Migration `0026_drop_documents_metadata` removed the column,
 * so the only shape left is the store record — and the one rule that still has
 * to hold is the one that was easy to get wrong when there were two shapes: a
 * LIST read must never carry a sealed value, and a single-record read must.
 */
import { describe, it, expect } from 'vitest';
import {
  documentDisplay,
  holderDisplayName,
  primaryIdentifier,
  readDocMetadata,
  revealDocMetadata,
  withDocMetadata,
} from '@/lib/records/docMetadata';
import { fieldsFor, identifierFields } from '@/lib/documentCategoryFields';

/**
 * A record as it is stored on Drive.
 *
 * `sealed` holds ciphertext — `revealRecord()` is what decrypts it — and is
 * present here precisely so the list-read test can prove it is not passed on.
 *
 * The ID-number key is per CATEGORY, not per module: `documents/pan_card`
 * declares `pan_number` where `documents/aadhaar_card` declares
 * `aadhaar_number`. The writer resolved it; nothing downstream re-derives it.
 */
const storeRecord = {
  id: 'doc-1',
  name: 'Rajesh Kumar PAN',
  open: { holder_name: 'Rajesh Kumar', expiry_date: '2032-01-01', customFields: [{ label: 'Gender', value: 'M' }] },
  masked: { pan_number: '••••234F' },
  sealed: { pan_number: 'enc:ABCDE1234F', date_of_birth: 'enc:1975-04-02' },
  searchHashes: { pan_number: 'abc123' },
  reminders: [{ key: 'expiry_date', label: 'Document Expiry', date: '2032-01-01', resolved: false }],
};

describe('readDocMetadata — the list read', () => {
  it('returns the record\'s open tier and its display masks', () => {
    const out = readDocMetadata(storeRecord);
    expect(out.open).toEqual(storeRecord.open);
    expect(out.masked).toEqual({ pan_number: '••••234F' });
  });

  it('carries no sealed value, in any form', () => {
    // THE point of a list read. `sealed` is ciphertext, but shipping it would
    // still hand the client a value the category's policy says it may not have,
    // and `searchHashes` is a blind index that must not leave the server either.
    const out = readDocMetadata(storeRecord);
    expect(out.open).not.toHaveProperty('pan_number');
    expect(out.open).not.toHaveProperty('date_of_birth');
    expect(JSON.stringify(out)).not.toContain('enc:');
    expect(JSON.stringify(out)).not.toContain('abc123');
  });

  it('renders as empty when the store could not be read', () => {
    // `loadRecords` returns nothing for a row whose store is unreadable and
    // reports it in `unreadable`; the row still has to render as a title.
    expect(readDocMetadata(undefined)).toEqual({ open: {}, masked: {} });
    expect(readDocMetadata(null)).toEqual({ open: {}, masked: {} });
    expect(readDocMetadata({})).toEqual({ open: {}, masked: {} });
  });
});

describe('revealDocMetadata — the single-record read', () => {
  it('merges the decrypted sealed tier over the open one', () => {
    // The sealed values are NOT in `open` — `revealRecord()` fetches and
    // decrypts them, and this is where the two halves become one record.
    const out = revealDocMetadata(storeRecord, {
      pan_number: 'ABCDE1234F',
      date_of_birth: '1975-04-02',
    });
    expect(out.open.pan_number).toBe('ABCDE1234F');
    expect(out.open.date_of_birth).toBe('1975-04-02');
    // And the open tier the record already carried survives alongside.
    expect(out.open.holder_name).toBe('Rajesh Kumar');
    expect(out.masked).toEqual({ pan_number: '••••234F' });
  });

  it('still reveals nothing when the sealed tier could not be read', () => {
    // A revoked Drive grant makes `revealRecord` return null. The document must
    // still open — just without the fields that live behind the seal.
    const out = revealDocMetadata(storeRecord, null);
    expect(out.open.holder_name).toBe('Rajesh Kumar');
    expect(out.open).not.toHaveProperty('pan_number');
  });
});

describe('withDocMetadata — the row envelope', () => {
  it('attaches the metadata without mutating the row', () => {
    const row: Record<string, any> = {
      id: 'doc-1', title: 'PAN', filePath: null, fileDriveId: null, pageCount: 0,
    };
    const out = withDocMetadata(row, readDocMetadata(storeRecord));
    expect(out.metadata).toEqual({ open: storeRecord.open, masked: storeRecord.masked });
    expect(row).not.toHaveProperty('metadata');
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE DOCUMENT MANAGER'S TWO DERIVED COLUMNS                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The manager lists all 83 sub-categories at once, so "Number" and "Holder"
 * cannot be a fixed pair of field names. Both used to be read through the
 * legacy `documents` vocabulary — `documentNumber`, which names six taxonomy
 * keys, and `holder_name`, which the spec-driven form never writes because it
 * asks "Belongs to" instead. A record filed through a module therefore showed
 * '-' in both columns while holding both facts.
 *
 * These run against the REAL category specs, so a dictionary change that leaves
 * a category with no identifier fails here rather than silently blanking a
 * column.
 */
const identifierSpecsFor = (moduleKey: string, documentKey: string) => {
  const spec = fieldsFor({ moduleKey, documentKey });
  const identifiers = new Set(identifierFields(spec));
  return spec.filter((f) => identifiers.has(f.fieldKey));
};

describe('primaryIdentifier — the Number column, for any category', () => {
  it('reads the identifier of a category fieldMap never named', () => {
    // THE reported bug. `voter_id_number` is not one of the six candidates
    // behind `documentNumber`, so this record rendered '-' with its number
    // stored, masked and blind-indexed correctly all along.
    const out = primaryIdentifier(
      { open: {}, masked: { voter_id_number: '••••4821' } },
      identifierSpecsFor('identity', 'voter_id'),
    );
    expect(out).toMatchObject({ key: 'voter_id_number', value: '••••4821' });
    // The category's own words, not one generic label for every kind of number.
    expect(out?.label).toBe('Voter ID Number');
  });

  it('still reads the legacy manager upload it always read', () => {
    const out = primaryIdentifier(
      readDocMetadata(storeRecord),
      identifierSpecsFor('identity', 'pan_card'),
    );
    expect(out).toMatchObject({ key: 'pan_number', value: '••••234F' });
  });

  it('falls back to the open tier when the identifier carries no mask', () => {
    // Either the category does not seal it, or the record predates its sealing.
    // Both look the same here: the value is in the open tier and nowhere else.
    const out = primaryIdentifier(
      { open: { registration_number: 'MH12AB3456' }, masked: {} },
      identifierSpecsFor('identity', 'birth_certificate'),
    );
    expect(out?.value).toBe('MH12AB3456');
  });

  it('prefers the mask over an open-tier copy of the same key', () => {
    // A record written before the key joined the encrypt list can carry both.
    // A LIST read must render the mask; preferring `open` would put a
    // plaintext identifier back in a response that promises not to carry one.
    const out = primaryIdentifier(
      { open: { aadhaar_number: '1234 5678 9012' }, masked: { aadhaar_number: '••••9012' } },
      identifierSpecsFor('identity', 'aadhaar_card'),
    );
    expect(out?.value).toBe('••••9012');
  });

  it('reads a pre-fix record that still holds the old fallback key', () => {
    // Records written before `resolveFieldKey` learned to ask the category are
    // filed under `document_number`, which 82 of the 83 categories do not
    // declare — so their real identifiers find nothing here. Rendering the
    // stored number beats rendering '-' while the repair script catches up.
    const out = primaryIdentifier(
      { open: {}, masked: { document_number: '••••4821' } },
      identifierSpecsFor('identity', 'driving_license'),
    );
    expect(out).toMatchObject({ key: 'document_number', value: '••••4821' });
    expect(out?.label).toBe('Document Number');
  });

  it('prefers the category own identifier over the legacy fallback', () => {
    // A repaired record can hold both for a moment. The category's own field is
    // the answer; the fallback is only ever consulted after it comes up empty.
    const out = primaryIdentifier(
      {
        open: {},
        masked: { document_number: '••••0000', license_number: '••••4821' },
      },
      identifierSpecsFor('identity', 'driving_license'),
    );
    expect(out).toMatchObject({ key: 'license_number', value: '••••4821' });
  });

  it('answers null rather than guessing when nothing identifies the record', () => {
    expect(primaryIdentifier({ open: { gender: 'F' }, masked: {} },
      identifierSpecsFor('identity', 'aadhaar_card'))).toBeNull();
    // A blank value is not an answer — the next candidate must still be tried.
    expect(primaryIdentifier(
      { open: { pan_number: '' }, masked: {} },
      identifierSpecsFor('identity', 'pan_card'),
    )).toBeNull();
    // No identifier fields at all (an operator turned them off) is not a crash.
    expect(primaryIdentifier({ open: { pan_number: 'ABCDE1234F' }, masked: {} }, [])).toBeNull();
  });
});

describe('holderDisplayName — the Holder column', () => {
  const empty = { open: {}, masked: {} };

  it('names the assigned member, which is all a module record has', () => {
    // The sub-category form hides `holder_name` and asks "Belongs to", so this
    // is the ONLY place the answer exists for a record filed through a module.
    expect(holderDisplayName({ holder: { name: 'Ramya' }, isGlobal: false }, empty)).toBe('Ramya');
  });

  it('prefers the assigned member over a typed name', () => {
    // `users.name` is read live, so it survives a rename; a typed copy does not.
    expect(holderDisplayName(
      { holder: { name: 'Ramya Krishnan' }, isGlobal: false },
      { open: { holder_name: 'Ramya K' }, masked: {} },
    )).toBe('Ramya Krishnan');
  });

  it('falls back to a typed holder_name for an older manager upload', () => {
    expect(holderDisplayName(
      { holder: null, isGlobal: true },
      { open: { holder_name: 'Lakshmi Krishnan' }, masked: {} },
    )).toBe('Lakshmi Krishnan');
  });

  it('says all members for a record filed against nobody', () => {
    // The same words the sub-category workspace renders for the same rows.
    expect(holderDisplayName({ holder: null, isGlobal: true }, empty)).toBe('All members');
    expect(holderDisplayName({ holder: null, isGlobal: false }, empty)).toBeNull();
  });

  it('a business record with no member belongs to the company — whatever was typed', () => {
    expect(holderDisplayName(
      { holder: null, isGlobal: false, companyId: 'c1', companyName: 'Acme Pvt Ltd' },
      { open: { holder_name: 'Ramesh' }, masked: {} },
    )).toBe('Acme Pvt Ltd');
    expect(holderDisplayName({ holder: null, isGlobal: true, companyId: 'c1' }, empty)).toBe('This company');
  });

  it('a business record filed under a member names the member', () => {
    expect(holderDisplayName(
      { holder: { name: 'Ramesh Iyer' }, isGlobal: false, companyId: 'c1', companyName: 'Acme Pvt Ltd' },
      empty,
    )).toBe('Ramesh Iyer');
  });
});

describe('documentDisplay — both facts, for one row', () => {
  it('fills a module-created record that carries neither legacy field', () => {
    const out = documentDisplay(
      { holder: { name: 'Ramya' }, isGlobal: false },
      { open: { constituency: 'Ward 12' }, masked: { voter_id_number: '••••4821' } },
      identifierSpecsFor('identity', 'voter_id'),
    );
    expect(out).toEqual({
      number: '••••4821',
      numberLabel: 'Voter ID Number',
      // Named, so the edit modal seeds its one generic number input from the
      // field this category actually stores the number in.
      numberKey: 'voter_id_number',
      holderName: 'Ramya',
    });
  });

  it('renders an unreadable store as blanks rather than throwing', () => {
    // `loadRecords` yields nothing for a row whose store is down; the row still
    // has to reach the page, with the columns simply empty.
    expect(documentDisplay(
      { holder: null, isGlobal: false },
      readDocMetadata(undefined),
      identifierSpecsFor('identity', 'pan_card'),
    )).toEqual({ number: null, numberLabel: null, numberKey: null, holderName: null });
  });
});

describe('every module can name a number', () => {
  // A category with no identifier is a category whose rows can only ever show
  // '-'. Spot-checked across modules so a dictionary edit that drops one is
  // caught here rather than noticed in the UI.
  it.each([
    ['identity', 'voter_id'],
    ['identity', 'driving_license'],
    ['identity', 'ration_card'],
    ['bank_investments', 'bank_statements_passbooks'],
  ])('%s/%s declares at least one identifier field', (moduleKey, documentKey) => {
    expect(identifierSpecsFor(moduleKey, documentKey).length).toBeGreaterThan(0);
  });
});
