/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE NAME A "KEEP BOTH" COPY IS FILED UNDER                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * "Keep both" is the only answer to the duplicate prompt that leaves the tenant
 * holding two records where the upload matched one, and it is only usable if
 * the two can be told apart afterwards. Two things go wrong when the copy keeps
 * the title verbatim:
 *
 *   · the list shows two rows nobody can distinguish;
 *   · the NEXT upload of that name matches whichever row was written last, so
 *     the pair grows by one prompt per upload and neither can be aimed at.
 *
 * `nextAvailableTitle` is what stops both. These cover the numbering; the SQL
 * predicate that gathers the candidates is `findTwin`'s, exercised in
 * documentDeletion.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

const { nextAvailableTitle } = await import('@/lib/records/documentVisibility');

/** A tx whose one query answers with the titles already in this category. */
function makeTx(titles: Array<string | null>) {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: async () => titles.map((title) => ({ title })),
  };
  return chain;
}

const next = (titles: Array<string | null>, title = 'Passport') =>
  nextAvailableTitle(makeTx(titles), 't1', 'cat-1', title);

describe('nextAvailableTitle', () => {
  it('leaves a free title alone', async () => {
    // A keep-both answer to a FILENAME match collides on the file, not the
    // name, so there is usually nothing to rename. Numbering it anyway would
    // make every such copy look like a second attempt.
    expect(await next([])).toBe('Passport');
  });

  it('numbers a taken title from 2', async () => {
    expect(await next(['Passport'])).toBe('Passport (2)');
  });

  it('walks past copies that already exist', async () => {
    expect(await next(['Passport', 'Passport (2)', 'Passport (3)']))
      .toBe('Passport (4)');
  });

  it('fills a gap rather than always taking the highest', async () => {
    // (2) was deleted; reusing it keeps the numbering readable instead of
    // climbing forever across a record's lifetime.
    expect(await next(['Passport', 'Passport (3)'])).toBe('Passport (2)');
  });

  it('compares case- and space-insensitively, as the match does', async () => {
    // `findTwin` matches on `lower(trim(title))`. If this disagreed, the name
    // it picked would still be a twin of what is already there — and the copy
    // would be refused as a duplicate of the record it was filed beside.
    expect(await next([' passport ', 'PASSPORT (2)'])).toBe('Passport (3)');
  });

  it('ignores rows whose title is unrelated', async () => {
    expect(await next(['Passport renewal', 'Old passport'])).toBe('Passport');
  });

  it('survives a null title on a row', async () => {
    expect(await next([null, 'Passport'])).toBe('Passport (2)');
  });

  it('returns a blank title untouched rather than numbering nothing', async () => {
    // Reached only if a caller lost the title on the way here; "(2)" would be
    // a worse name than the empty one the validation layer will refuse.
    expect(await next(['Passport'], '   ')).toBe('');
  });
});
