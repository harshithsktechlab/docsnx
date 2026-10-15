/**
 * ── FILES PICKED ON ONE PAGE, OPENED ON ANOTHER ────────────────────────────
 *
 * There is one Upload button now, and it can be pressed anywhere — the bottom
 * nav's `+` is on Home and Follow Up too. The user picks files first, and only
 * then do we know where they belong: one file goes to the Document Manager's
 * upload form, several go to Power Scan.
 *
 * A `File` cannot ride in a URL, but App Router navigations are client-side and
 * keep module memory, so the picked files wait here and the destination page
 * takes them on mount. The listener covers the case where that page is already
 * mounted (the `+` pressed while on Docs) and so will not mount again.
 *
 * Read-and-clear: a file handed over once must not reappear on a later visit.
 */

let pending: File[] | null = null;
const listeners = new Set<() => void>();

export function stashPendingFiles(files: File[]): void {
  pending = files.length ? files : null;
  listeners.forEach((fn) => fn());
}

export function takePendingFiles(): File[] | null {
  const files = pending;
  pending = null;
  return files;
}

/** Peek without taking — lets a page leave files meant for another page alone. */
export function pendingFileCount(): number {
  return pending?.length ?? 0;
}

export function onPendingFiles(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
