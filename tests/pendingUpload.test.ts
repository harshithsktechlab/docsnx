/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PENDING-UPLOAD STASH — A HINT RIDES WITH ITS FILES, ONCE           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A category page whose user answered "this is not a <that>" hands the file to
 * the Document Manager with the category already chosen. The hint must belong
 * to THAT hand-over only: a later plain upload must not inherit a category
 * selection from an earlier one.
 */
import { describe, it, expect } from 'vitest';
import {
  stashPendingFiles, takePendingFiles, takePendingHint, pendingFileCount,
} from '@/lib/pendingUpload';

const file = () => new File([new Uint8Array([1])], 'scan.jpg', { type: 'image/jpeg' });

describe('pending upload hint', () => {
  it('comes with the files it was stashed with, and only once', () => {
    stashPendingFiles([file()], { categoryId: 'cat-1', read: true });

    expect(pendingFileCount()).toBe(1);
    expect(takePendingFiles()).toHaveLength(1);
    expect(takePendingHint()).toEqual({ categoryId: 'cat-1', read: true });
    expect(takePendingHint()).toBeNull();
  });

  it('is not inherited by the next plain stash', () => {
    stashPendingFiles([file()], { categoryId: 'cat-1', read: false });
    // Never taken — the destination page was not mounted.
    stashPendingFiles([file()]);

    takePendingFiles();
    expect(takePendingHint()).toBeNull();
  });

  it('is dropped with an empty stash', () => {
    stashPendingFiles([], { categoryId: 'cat-1', read: true });

    expect(pendingFileCount()).toBe(0);
    expect(takePendingHint()).toBeNull();
  });
});
