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

/**
 * Where the destination form should file them, when the sender already knows.
 *
 * Set by a category page whose AI read said "this is not a <that>" and whose
 * user then answered the question: the Document Manager opens with the file
 * attached AND the answer already selected, rather than asking again.
 *
 *   categoryId  the `document_categories` row to select.
 *   read        read the file against it straight away (the user said Yes to
 *               the AI's category). False for the module's Other, which has no
 *               fields worth guessing at.
 */
export interface PendingUploadHint {
  categoryId: string;
  read: boolean;
}

let pending: File[] | null = null;
let pendingHint: PendingUploadHint | null = null;
const listeners = new Set<() => void>();

export function stashPendingFiles(files: File[], hint?: PendingUploadHint): void {
  pending = files.length ? files : null;
  // Replaced on every stash, so one upload's hint never leaks onto the next.
  pendingHint = pending ? hint ?? null : null;
  listeners.forEach((fn) => fn());
}

export function takePendingFiles(): File[] | null {
  const files = pending;
  pending = null;
  return files;
}

/** The hint that came with the files just taken. Read-and-clear, like the files. */
export function takePendingHint(): PendingUploadHint | null {
  const hint = pendingHint;
  pendingHint = null;
  return hint;
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
