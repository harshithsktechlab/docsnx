/**
 * Guards on what deletion means for a document.
 *
 * The product rule is narrow and easy to half-implement: a deleted document
 * disappears from every place a user can see it, the row survives with
 * `status = 'deleted'` for the Docsnx admin, it carries no URL, and uploading
 * the same document again REUSES that row rather than leaving a tombstone
 * behind and minting a second one.
 *
 * The dangerous half is the first clause. `documents` is the single table
 * behind all eighteen record modules, so "every place" is roughly a dozen
 * queries spread over routes that have nothing else in common. One of them
 * forgetting the predicate is invisible in review and invisible in a unit test
 * of that route — it just quietly lists deleted documents. The source scan
 * below is the only check that sees all of them at once.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');

/**
 * Every source file that reads `documents`, found rather than listed — a
 * hardcoded list would go stale the moment someone adds a route, which is
 * exactly the case this is meant to catch.
 */
function filesReadingDocuments(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/\.from\(documents\)|db\.query\.documents\./.test(text)) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/**
 * Reads that are deliberately NOT filtered, each for a stated reason. Removing
 * a file from this set should mean adding the predicate, never the reverse.
 */
const EXEMPT: Record<string, string> = {
  // Docsnx-admin analytics. The whole point of retaining the row is that these
  // can still see it; they are not user-facing surfaces.
  'app/api/admin/tenants/route.ts':
    'admin analytics — retained rows are what the admin is meant to analyse',
  'app/api/admin/dashboard/summary/route.ts':
    'admin analytics — same',
  // Account erasure. A tombstoned document still owns a Drive object and a file
  // on disk until it is purged; filtering them out here would leave exactly
  // those behind, permanently, in the one operation whose entire purpose is
  // that nothing survives it.
  'lib/account/accountErasure.ts':
    'erasure — a soft-deleted row still owns files, and this is what removes them',
};

describe('every user-facing read of documents excludes deleted rows', () => {
  it('filters on both status and deleted_at, or is a stated exemption', () => {
    const offenders: string[] = [];

    for (const file of filesReadingDocuments()) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (EXEMPT[rel]) continue;

      const text = fs.readFileSync(file, 'utf8');
      // `visibleDocument()` is the single predicate that carries both halves.
      // Spelling them out by hand is accepted too — what matters is that the
      // read cannot return a tombstone, not which spelling gets it there.
      const guarded = text.includes('visibleDocument(')
        || (/documents\.status/.test(text) && /documents\.deletedAt/.test(text));
      if (!guarded) offenders.push(rel);
    }

    expect(offenders, `these read documents without excluding deleted rows:\n  ${offenders.join('\n  ')}`)
      .toEqual([]);
  });

  it('finds a non-trivial number of reads, so the scan cannot silently match nothing', () => {
    // A regex that stops matching would make the check above pass vacuously.
    expect(filesReadingDocuments().length).toBeGreaterThan(8);
  });
});

describe('every delete path writes the same thing', () => {
  /**
   * Single document, list multi-select, the other seventeen modules — and
   * removing the member a record was filed under, which deletes the
   * records the admin ticked in the removal picker.
   */
  const DELETE_SITES = [
    'app/api/documents/[id]/route.ts',
    'app/api/documents/bulk-delete/route.ts',
    'lib/records/handler.ts',
    'lib/account/memberRemoval.ts',
  ];

  it('sets the deleted state through the shared helper, never by hand', () => {
    for (const rel of DELETE_SITES) {
      const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
      expect(text, `${rel} should use deletedDocumentState()`)
        .toContain('deletedDocumentState()');
      // The pattern that predates the rule: stamping only the timestamp, which
      // leaves `status` at 'active' and leaves the URL on the row.
      expect(text, `${rel} still hand-writes a deleted_at-only soft delete`)
        .not.toMatch(/\.set\(\{\s*deletedAt: new Date\(\)/);
    }
  });

  it('takes the document off Drive as well as out of the lists', () => {
    for (const rel of DELETE_SITES) {
      const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
      // The half that is invisible in a unit test of the route: tombstoning the
      // row hides the document, but its ciphertext and every field extracted
      // from it stay on the tenant's Drive until this runs.
      expect(text, `${rel} tombstones the row but never purges Drive`)
        .toMatch(/purgeDeletedDocuments?\(/);
      expect(text, `${rel} leaves a stale AI analysis describing the deleted document`)
        .toContain('invalidateAnalysisCache(');
    }
  });

  it('reads the Drive pointer BEFORE the update that nulls it', () => {
    for (const rel of DELETE_SITES) {
      const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
      const update = text.indexOf('deletedDocumentState()');
      const purge = text.search(/purgeDeletedDocuments?\(/);
      // `deletedDocumentState()` clears `file_drive_id` and RETURNING reports
      // the NEW row, so a purge that sources its ids from the update itself
      // would always find null and silently delete nothing.
      expect(purge, `${rel} purges before it tombstones`).toBeGreaterThan(update);
    }
  });
});

describe('deletedDocumentState', () => {
  it('marks the row deleted AND strips its URL', async () => {
    const { deletedDocumentState } = await import('@/lib/records/documentVisibility');
    const state = deletedDocumentState();

    expect(state.status).toBe('deleted');
    expect(state.deletedAt).toBeInstanceOf(Date);
    // The URL is the part that is easy to forget and the part that matters: a
    // row that kept its file_path is still fetchable by anything holding it.
    expect(state.filePath).toBeNull();
    // And the Drive pointer, whose object the purge permanently deletes.
    // Leaving it set would make the revival re-upload try to overwrite a file
    // that no longer exists, which 404s — the delete would break the re-upload.
    expect(state.fileDriveId).toBeNull();
  });

  it('strips everything that names, fingerprints or locates the file', async () => {
    const { deletedDocumentState } = await import('@/lib/records/documentVisibility');
    const state = deletedDocumentState() as Record<string, unknown>;

    // The file itself is gone from Drive by the time this row is read again, so
    // none of these describes anything that still exists. Enumerated one by one
    // rather than as a loop so a failure names the column that regressed.
    //
    // `file_name` is the one that started this: `Aadhaar_Ramesh.pdf` sitting on
    // a tombstone forever is the single most identifying thing left on the row.
    expect(state.fileName, 'file_name').toBeNull();
    expect(state.mimeType, 'mime_type').toBeNull();
    // Denormalised from vault_json_files, which is still authoritative — this
    // copy is residue pointing into the tenant's Drive.
    expect(state.jsonDriveId, 'json_drive_id').toBeNull();
    // Digests do not READ the document, but they CONFIRM one: given a candidate
    // file they prove this row was that file.
    expect(state.contentHash, 'content_hash').toBeNull();
    expect(state.sourceHash, 'source_hash').toBeNull();
    // Write-only on the row; the version that opens a page is framed into that
    // page's ciphertext, and every page is deleted by now.
    expect(state.keyVersion, 'key_version').toBeNull();
    expect(state.encryptedSize, 'encrypted_size').toBeNull();
  });

  it('keeps the facts that let the admin COUNT what a tenant had', async () => {
    const { deletedDocumentState } = await import('@/lib/records/documentVisibility');
    const state = deletedDocumentState();

    // The tombstone exists to say "one document was here". These columns are
    // that statement, and this object must not touch them — a stray
    // `fileSize: null` would silently rewrite every tenant's retained history.
    //
    // `file_size` is safe to keep because the quota sum filters on
    // `visibleDocument()` (storage.ts), so a deleted row bills nobody.
    expect(state).not.toHaveProperty('title');
    expect(state).not.toHaveProperty('fileSize');
    expect(state).not.toHaveProperty('pageCount');
    // Where it was filed and for whom.
    expect(state).not.toHaveProperty('categoryId');
    expect(state).not.toHaveProperty('categoryModuleKey');
    expect(state).not.toHaveProperty('categoryDocumentKey');
    expect(state).not.toHaveProperty('holderId');
    expect(state).not.toHaveProperty('userId');
    expect(state).not.toHaveProperty('isGlobal');
    expect(state).not.toHaveProperty('createdAt');
  });

  it('stamps a fresh timestamp per call, not one frozen at import', async () => {
    const { deletedDocumentState } = await import('@/lib/records/documentVisibility');
    const first = deletedDocumentState();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const second = deletedDocumentState();
    vi.useRealTimers();

    expect(second.deletedAt.getTime()).toBeGreaterThan(first.deletedAt.getTime());
  });
});

describe('revivedDocumentState', () => {
  it('lifts both halves of the tombstone', async () => {
    const { revivedDocumentState } = await import('@/lib/records/documentVisibility');
    const state = revivedDocumentState();

    // Lifting only one would leave the row in the half-state every read
    // disagrees about: visible to a status check, invisible to a deleted_at one.
    expect(state.status).toBe('active');
    expect(state.deletedAt).toBeNull();
  });

  it('does not set a URL — the caller supplies the new one', async () => {
    const { revivedDocumentState } = await import('@/lib/records/documentVisibility');
    // Reviving with a stale filePath, or with none, would produce an active
    // document that cannot be opened. createRecord writes the fresh one.
    expect(revivedDocumentState()).not.toHaveProperty('filePath');
  });
});

describe('findDeletedTwin', () => {
  /** Records what the query was built with, so the predicate can be inspected. */
  function fakeTx(rows: any[]) {
    const calls: any = {};
    const chain = {
      select: (cols: any) => { calls.columns = cols; return chain; },
      from: (t: any) => { calls.table = t; return chain; },
      where: (c: any) => { calls.where = c; return chain; },
      orderBy: (o: any) => { calls.orderBy = o; return chain; },
      limit: (n: number) => { calls.limit = n; return Promise.resolve(rows); },
    };
    return { tx: chain as any, calls };
  }

  /**
   * The literal values bound into a Drizzle condition.
   *
   * `JSON.stringify` cannot be used: a condition holds Column objects that
   * point back at their PgTable, so the graph is circular. This walks it with a
   * seen-set and keeps only the strings, which is all the assertions need.
   */
  function boundValues(node: any, seen = new WeakSet()): string[] {
    if (typeof node === 'string') return [node];
    if (!node || typeof node !== 'object') return [];
    if (seen.has(node)) return [];
    seen.add(node);
    return Object.values(node).flatMap((v) => boundValues(v, seen));
  }

  const candidate = { title: 'Passport', categoryId: 'cat-1', fileName: 'passport.pdf' };

  it('returns the tombstone to revive', async () => {
    const { findDeletedTwin } = await import('@/lib/records/documentVisibility');
    const { tx } = fakeTx([{ id: 'doc-1', title: 'Passport', fileName: 'passport.pdf' }]);

    // `reason` names the arm that matched, so the caller can say WHY. Both
    // arms fire here; title is reported, because it is the field the user
    // typed and so makes the more recognisable message.
    await expect(findDeletedTwin(tx, 't1', candidate)).resolves.toEqual({
      id: 'doc-1', title: 'Passport', fileName: 'passport.pdf', reason: 'title',
    });
  });

  it('returns null rather than undefined when nothing matches', async () => {
    const { findDeletedTwin } = await import('@/lib/records/documentVisibility');
    const { tx } = fakeTx([]);

    // The caller branches on this; `undefined` would still be falsy today but
    // makes the contract ambiguous for anything that checks `=== null`.
    await expect(findDeletedTwin(tx, 't1', candidate)).resolves.toBeNull();
  });

  it('takes only the most recently deleted match', async () => {
    const { findDeletedTwin } = await import('@/lib/records/documentVisibility');
    const { tx, calls } = fakeTx([{ id: 'doc-1', title: 'Passport' }]);
    await findDeletedTwin(tx, 't1', candidate);

    // Several delete/re-upload cycles leave several tombstones; the newest is
    // the one the user plausibly means.
    expect(calls.limit).toBe(1);
    expect(calls.orderBy).toBeTruthy();
  });

  it('scopes the match to the tenant, to deleted rows, and to one category', async () => {
    const { findDeletedTwin } = await import('@/lib/records/documentVisibility');
    const { tx, calls } = fakeTx([]);
    await findDeletedTwin(tx, 't1', candidate);

    // Serialising the condition is the only way to see all four parts at once.
    // Category is part of the match rather than an arm of it: revival
    // overwrites the row's Drive object in place, and that object lives in the
    // category's folder with the category bound into its AAD.
    const values = boundValues(calls.where);
    expect(values).toContain('t1');
    expect(values).toContain('deleted');
    expect(values).toContain('cat-1');
    expect(values).toContain('passport.pdf');
  });

  it('drops the filename arm when the upload has no filename', async () => {
    const { findDeletedTwin } = await import('@/lib/records/documentVisibility');
    const { tx, calls } = fakeTx([]);
    await findDeletedTwin(tx, 't1', { title: 'Passport', categoryId: 'cat-1', fileName: null });

    // An `eq(fileName, null)` arm would match every file-less record in the
    // category and revive an unrelated one.
    expect(boundValues(calls.where)).not.toContain('passport.pdf');
  });

  it('drops the filename arm when the name is one the phone made up', async () => {
    const { findDeletedTwin, findActiveTwin } = await import('@/lib/records/documentVisibility');

    // iOS Safari uploads every Photos pick as `image.jpeg`. Compared, that name
    // made the second phone photo in a category a "duplicate" of the first —
    // refused over the live rows, and silently written onto an unrelated
    // tombstone over the deleted ones. Neither lookup may bind it.
    for (const fileName of ['image.jpeg', 'image.jpg', 'IMG.jpg', 'image (1).jpeg', 'scan.pdf']) {
      const deleted = fakeTx([]);
      await findDeletedTwin(deleted.tx, 't1', { title: 'Aadhaar front', categoryId: 'cat-1', fileName });
      expect(boundValues(deleted.calls.where), fileName).not.toContain(fileName);

      const active = fakeTx([]);
      await findActiveTwin(active.tx, 't1', { title: 'Aadhaar front', categoryId: 'cat-1', fileName });
      expect(boundValues(active.calls.where), fileName).not.toContain(fileName);
    }

    // A name that DOES name something still binds.
    const named = fakeTx([]);
    await findActiveTwin(named.tx, 't1', candidate);
    expect(boundValues(named.calls.where)).toContain('passport.pdf');
  });

  it('still revives a tombstone whose filename was scrubbed', async () => {
    const { findDeletedTwin } = await import('@/lib/records/documentVisibility');
    // What a tombstone looks like now: `deletedDocumentState()` cleared
    // `file_name`, so the row carries only its title.
    const { tx } = fakeTx([{ id: 'doc-1', title: 'Passport', fileName: null }]);

    const twin = await findDeletedTwin(tx, 't1', candidate);

    // The title arm is the ONLY one that can fire against a scrubbed row —
    // `file_name = 'passport.pdf'` is never true of NULL — so revival now rests
    // entirely on it. If this breaks, every delete/re-upload cycle strands a
    // dead row instead of reusing it.
    expect(twin?.id).toBe('doc-1');
    expect(twin?.reason).toBe('title');
  });
});

describe('the upload route revives instead of duplicating', () => {
  const ROUTE = path.join(SRC, 'app/api/documents/route.ts');

  it('looks for a deleted twin before creating a record', () => {
    const text = fs.readFileSync(ROUTE, 'utf8');
    expect(text).toContain('findDeletedTwin');
    // The lookup must feed `replaceId` — that is what makes createRecord update
    // the existing row (and lift its tombstone) rather than insert a new one.
    expect(text).toMatch(/replaceId:\s*targetId/);
  });

  it('does not override a replaceId the user explicitly chose', () => {
    const text = fs.readFileSync(ROUTE, 'utf8');
    // The duplicate modal's "replace this one" is an explicit choice and must
    // outrank the server's guess.
    expect(text).toMatch(/if \(!targetId\) \{/);
  });

  it('reactivates the row it replaces', () => {
    const handler = fs.readFileSync(path.join(SRC, 'lib/records/handler.ts'), 'utf8');
    // Without this in the conflict-update branch, the twin lookup would find
    // the row, overwrite its file, and leave it marked deleted — an upload
    // that silently does nothing the user can see.
    expect(handler).toContain('...revivedDocumentState()');
  });
});
