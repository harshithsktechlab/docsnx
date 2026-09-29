'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE TOAST HALF OF THE CONTRACT                                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `apiErrorMessage` decides WHAT to say. This decides where it appears, and it
 * is deliberately the only way a failure becomes a toast, for two reasons the
 * app was getting wrong in opposite directions:
 *
 *   · 26 call sites used `alert()`. A blocking, unstyled, un-themed OS modal
 *     that stops the page — for "Failed to delete". It also cannot show two
 *     lines, which is why every one of those sites threw away the advice half
 *     of the message and kept only the failure half.
 *
 *   · The sites that did toast passed a single string, so the user got
 *     "Network error deleting record" in bold with nothing underneath. Sonner
 *     renders a description in a lighter weight below the title — which is
 *     exactly the shape "what happened / what to do" wants, and it was unused.
 *
 * ── WHY THE ID MATTERS ─────────────────────────────────────────────────────
 * A list that refetches on an interval, or a form the user submits twice while
 * offline, raises the same toast repeatedly. Sonner stacks them. Five identical
 * toasts is not five times the information; it is a wall the user dismisses
 * without reading, including the one that mattered. A stable id per call site
 * makes the second one REPLACE the first.
 */

import { toast } from 'sonner';
import { apiErrorParts, type MessageOptions } from './apiErrorMessage';
import type { ApiOutcome } from './outcome';

export interface ToastErrorOptions extends MessageOptions {
  /**
   * Stable across retries of the same operation, so a repeat replaces rather
   * than stacks. Defaults to the subject + action, which is usually right.
   */
  id?: string;
  /** Milliseconds. Longer for messages carrying a number or an instruction. */
  duration?: number;
}

/**
 * Report a failed request as a toast, and say whether it did.
 *
 * Returns false for the cases that must NOT raise one — a success, and a
 * request the caller itself aborted — so a call site can be unconditional:
 *
 *   const outcome = await apiRequest('/api/medical');
 *   if (!outcome.ok) { toastApiError(outcome, { subject: 'medical records', action: 'loading' }); return; }
 */
export function toastApiError(outcome: ApiOutcome, options: ToastErrorOptions = {}): boolean {
  if (outcome.ok) return false;

  const { title, description } = apiErrorParts(outcome, options);
  // An aborted request produces an empty title by design; nothing failed.
  if (!title) return false;

  const id = options.id
    || `api-error:${options.subject || 'request'}:${options.action || 'generic'}`;

  toast.error(title, {
    id,
    ...(description ? { description } : {}),
    // Two-part messages carry an instruction, and an instruction the user did
    // not finish reading is the same as no instruction at all.
    duration: options.duration ?? (description ? 8000 : 5000),
  });
  return true;
}

/**
 * The same decision, for a form that shows its errors inline.
 *
 * Exists so a page never has to choose between the two surfaces by hand: the
 * split the product settled on is validation-and-save inline, everything else
 * as a toast, and this is the inline side reading from the same source.
 *
 *   const outcome = await postUpload('/api/medical', formData);
 *   if (!outcome.ok) { setFormError(formErrorFrom(outcome, { subject: 'medical record' })); return; }
 */
export { apiErrorMessage as formErrorFrom } from './apiErrorMessage';
