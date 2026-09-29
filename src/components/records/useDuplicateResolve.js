'use client';

import { useCallback, useState } from 'react';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE 409 → PROMPT WIRING, WRITTEN ONCE                                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every write path in the app can be refused with "this already exists", and
 * every one of them owes the user the same three answers — keep the existing
 * record, keep the new one, keep both. Fourteen module pages used to answer
 * that refusal fourteen different ways: six raised a browser `window.confirm`
 * (OK/Cancel, so old-or-new and nothing else) and eight let it land as a red
 * toast with no answer at all.
 *
 * This hook is the middle of it: it holds the 409 BODY VERBATIM — the sentence,
 * the matched record, its file, and whether keeping both is on offer — and
 * hands `DuplicateResolveDialog` the props it already expects.
 *
 * ── THE PAGE STILL OWNS ITS SAVE ───────────────────────────────────────────
 * `resubmit` is the page's own submit, called again with the user's answer:
 *
 *   · `{ force: true }`    → post `forceSave`, overwriting the matched record.
 *   · `{ keepBoth: true }` → post `keepBoth`, filing a SEPARATE record beside
 *     it under a numbered title the server resolves.
 *
 * It can be given once (most pages have one save) or per refusal, which is what
 * a page with both an add form and an edit form needs: the two post different
 * bodies, and an EDIT can answer nothing at all — it names the record it writes
 * onto, so the server withdraws both overwrite and fork and the prompt is left
 * with "keep the existing one" and a link. Passing no `resubmit` for those is
 * therefore correct rather than a gap.
 *
 * The prompt closes BEFORE the resubmit runs, deliberately: that write can be
 * refused again (a keep-both answer to an identifier clash is), and the refusal
 * has to be able to re-open this dialog with the new body. Closing afterwards
 * would clear the answer that had just arrived.
 *
 * Nothing here decides what may be answered. `keepBothAllowed` and
 * `keepNewAllowed` come from the server (`conflictResponsePayload`) and the
 * dialog reads them off the body; a client that offered more than the server
 * allows would only produce a button that 409s.
 */
export default function useDuplicateResolve(defaultResubmit) {
  /**
   * The 409 body, plus what the write that was refused looked like — the file
   * and the title the prompt previews as "uploading now", and the save to call
   * again with the answer.
   */
  const [pending, setPending] = useState(null);

  /**
   * Did this response refuse the write as a duplicate?
   *
   * Returns true when the prompt has taken over, so the caller can `return`
   * instead of falling through to its own error handling — a duplicate is a
   * question waiting for an answer, not a failure to report.
   *
   * @param {Response} res
   * @param {object} json  the parsed body, already read by the caller
   * @param {{newFile?: File|null, newTitle?: string, resubmit?: Function}} context
   */
  const intercept = useCallback((res, json, context = {}) => {
    if (res?.status === 409 && json?.requiresConfirmation) {
      setPending({ match: json, ...context });
      return true;
    }
    return false;
  }, []);

  const close = useCallback(() => setPending(null), []);

  const answer = (option) => {
    const again = pending?.resubmit ?? defaultResubmit;
    setPending(null);
    // Absent only where the server has already withdrawn both answers, so
    // nothing can call this — but a page that wires the prompt without one
    // should close cleanly rather than throw.
    if (typeof again === 'function') again(option);
  };

  const dialogProps = {
    open: Boolean(pending),
    match: pending?.match ?? null,
    newFile: pending?.newFile ?? null,
    newTitle: pending?.newTitle ?? '',
    onKeepExisting: close,
    onKeepNew: () => answer({ force: true }),
    onKeepBoth: () => answer({ keepBoth: true }),
  };

  return { match: pending?.match ?? null, intercept, close, dialogProps };
}
