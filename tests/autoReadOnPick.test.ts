/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PICKING A CATEGORY IS THE SECOND HALF OF THE READ                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * When `/api/documents/autofill` cannot place a document, it sends no fields
 * and the form asks the user to choose. Before this rule existed, choosing did
 * nothing: the user got an empty form and had to find "Rescan with AI" to make
 * the read they had already asked for happen. These assert the four ways the
 * automatic version could go wrong instead — reading twice, reading while
 * another read is in flight, reading into a form whose fields have not arrived,
 * and reading on the edit modal, which owns neither the file nor the category.
 */
import { describe, it, expect } from 'vitest';
import { autoReadFor, autoReadKey } from '@/lib/records/autoReadOnPick';

const FILE = { name: 'pan.pdf', size: 1024, lastModified: 1700000000000 };
const PAN = { id: 'cat-1', moduleKey: 'identity', documentKey: 'pan_card' };

/** The state right after an unclassified read, with a category now picked. */
const ready = (overrides = {}) => ({
  armed: true,
  file: FILE,
  category: PAN,
  specSettled: true,
  busy: false,
  lastKey: '',
  editing: false,
  ...overrides,
});

describe('autoReadFor', () => {
  it('reads the file against the category the user just picked', () => {
    expect(autoReadFor(ready())).toBe(autoReadKey(FILE, PAN));
  });

  it('does not read when the last scan did not ask for a category', () => {
    // A clean classification parks its OWN answer; re-reading would spend a
    // second call to learn what the form already holds.
    expect(autoReadFor(ready({ armed: false }))).toBe('');
  });

  it('reads a given file-and-category combination exactly once', () => {
    const key = autoReadKey(FILE, PAN);
    expect(autoReadFor(ready({ lastKey: key }))).toBe('');
  });

  it('reads again when the user moves the document to a different category', () => {
    const other = { id: 'cat-2', moduleKey: 'identity', documentKey: 'passport' };
    expect(autoReadFor(ready({ category: other, lastKey: autoReadKey(FILE, PAN) })))
      .toBe(autoReadKey(FILE, other));
  });

  it('reads again for a different file with the same name', () => {
    // Remove, re-pick, same name, different bytes: a fresh document deserves a
    // fresh read, and File identity would not have noticed.
    const replaced = { ...FILE, size: 2048 };
    expect(autoReadFor(ready({ file: replaced, lastKey: autoReadKey(FILE, PAN) })))
      .toBe(autoReadKey(replaced, PAN));
  });

  it('waits for the category’s spec rather than reading into an empty form', () => {
    // The failure this prevents is silent: the values come back fine and are
    // dropped, and the user is told nothing on the document matched.
    expect(autoReadFor(ready({ specSettled: false }))).toBe('');
  });

  it('does not start a read while one is already in flight', () => {
    expect(autoReadFor(ready({ busy: true }))).toBe('');
  });

  it('never fires on the edit modal', () => {
    // That form has its own file, its own field state, and a category fixed by
    // the record — a re-read there must stay the user's explicit choice.
    expect(autoReadFor(ready({ editing: true }))).toBe('');
  });

  it('waits until there is both a file and a fully resolved category', () => {
    expect(autoReadFor(ready({ file: null }))).toBe('');
    expect(autoReadFor(ready({ category: null }))).toBe('');
    // An id the master list has not resolved to a taxonomy pair yet: there is
    // no route to call with it.
    expect(autoReadFor(ready({ category: { id: 'cat-1' } }))).toBe('');
  });
});
