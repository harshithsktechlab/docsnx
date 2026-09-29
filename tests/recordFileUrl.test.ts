/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE URL A RECORD'S FILE IS SERVED FROM IS DERIVED, NOT STORED          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `documents.file_path` is written once, from the scope of the page doing the
 * writing, and is never revised. Two consequences, both live in production:
 *
 *   1. A record filed from the Document Manager into a category the Document
 *      Manager does not own keeps `/api/records/documents/<id>/file`. The scope
 *      that owns `property_legal/will_nomination` is `wills_estate`, so the
 *      serve route resolved the row inside the wrong category set and answered
 *      404 on a file sitting intact on Drive.
 *
 *   2. Rows written before the vault pipeline landed carry a `file_path` with
 *      no `file_drive_id`. Every list gates its View / Download / Print
 *      controls on `filePath` being truthy, so those records rendered an eye
 *      icon whose only possible answer is 409 VAULT_FILE_MISSING.
 *
 * Both are silent until the user clicks, and both look like data loss when they
 * land. These assert the derivation directly.
 */
import { describe, it, expect } from 'vitest';
import { servableFilePath, vaultFilePath } from '@/lib/records/fileUrl';

describe('servableFilePath', () => {
  it('routes through the scope that OWNS the category, not the one that wrote it', () => {
    // Written from the Document Manager; the category belongs to wills_estate.
    const row = {
      id: 'doc-1',
      filePath: '/api/records/documents/doc-1/file',
      fileDriveId: 'drive-1',
      categoryModuleKey: 'property_legal',
      categoryDocumentKey: 'will_nomination',
    };
    expect(servableFilePath(row)).toBe('/api/records/wills_estate/doc-1/file');
  });

  it('corrects a tax_compliance record misfiled under the documents scope', () => {
    const row = {
      id: 'doc-2',
      filePath: '/api/records/documents/doc-2/file',
      fileDriveId: 'drive-2',
      categoryModuleKey: 'tax_compliance',
      categoryDocumentKey: 'tds_certificates',
    };
    expect(servableFilePath(row)).toBe('/api/records/tax_compliance/doc-2/file');
  });

  it('leaves an already-correct path alone', () => {
    const row = {
      id: 'doc-3',
      filePath: '/api/records/rentals/doc-3/file',
      fileDriveId: 'drive-3',
      categoryModuleKey: 'rentals_subscriptions',
      categoryDocumentKey: 'rental_agreements',
    };
    expect(servableFilePath(row)).toBe('/api/records/rentals/doc-3/file');
  });

  it('reports NO path for a row whose bytes were never sealed to Drive', () => {
    // Ten of production's sixteen records look exactly like this: a path from
    // an older writer, and nothing behind it.
    const row = {
      id: 'doc-4',
      filePath: '/api/records/documents/doc-4/file',
      fileDriveId: null,
      categoryModuleKey: 'identity',
      categoryDocumentKey: 'aadhaar_card',
    };
    expect(servableFilePath(row)).toBeNull();
  });

  it('keeps serving pre-vault attachments from disk', () => {
    // The authenticated static handler still owns these; the taxonomy scope has
    // no bearing on them, and they have no Drive object by definition.
    const row = {
      id: 'doc-5',
      filePath: '/uploads/1699999999-passport.pdf',
      fileDriveId: null,
      categoryModuleKey: 'identity',
      categoryDocumentKey: 'passport',
    };
    expect(servableFilePath(row)).toBe('/uploads/1699999999-passport.pdf');
  });

  it('does not blank a file that exists just because its category is unmapped', () => {
    const row = {
      id: 'doc-6',
      filePath: '/api/records/documents/doc-6/file',
      fileDriveId: 'drive-6',
      categoryModuleKey: 'not_a_module',
      categoryDocumentKey: 'not_a_category',
    };
    expect(servableFilePath(row)).toBe('/api/records/documents/doc-6/file');
  });

  it('reports no path for a record that owns no file at all', () => {
    // A bank account or a demat account: a real record, no attachment.
    expect(servableFilePath({
      id: 'doc-7',
      filePath: null,
      fileDriveId: null,
      categoryModuleKey: 'bank_investments',
      categoryDocumentKey: 'bank_statements_passbooks',
    })).toBeNull();
  });
});

describe('vaultFilePath', () => {
  it('is the route the client fetches, never the Drive webViewLink', () => {
    expect(vaultFilePath('medical', 'abc')).toBe('/api/records/medical/abc/file');
  });
});
