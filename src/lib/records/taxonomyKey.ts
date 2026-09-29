/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   NAMING A CATEGORY AN OPERATOR INVENTED                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Sibling of customFieldKey.ts, and for the same reason: the SERVER derives the
 * key from the label typed on the screen, and the key is never accepted from the
 * client. A caller that could choose it could choose `pan_card` and take over
 * the Drive folder every tenant's identity ciphertext already lives in — and
 * that folder name is bound into the ciphertext's AAD, so the theft would also
 * be undetectable as a rename.
 *
 * ── THE KEY IS FOREVER ─────────────────────────────────────────────────────
 * documentCategories.ts states the rule this file exists to keep: a
 * `(moduleKey, documentKey)` pair is immutable once anything is filed under it.
 * The consequences of getting one wrong at creation are therefore permanent, so
 * three things are checked BEFORE a row exists rather than after:
 *
 *  1. IT MUST BE A LEGAL DRIVE PATH SEGMENT. Checked with `isSafeKeyPart`, the
 *     same predicate the storage layer applies — not a second regex that could
 *     drift from it. A key that fails there is one whose records cannot be
 *     stored at all, and the failure would land on a user's upload, weeks later.
 *
 *  2. IT MUST NOT COLLIDE — INCLUDING WITH A RETIRED ROW. `taken` must be every
 *     key in the module, active and inactive alike. A retired category is a
 *     tombstone whose records still point at it; reissuing its key would file
 *     new records into an old category's folder and silently merge two things
 *     that were deliberately separated.
 *
 *  3. THE LABEL MUST SURVIVE THE AI MASKER. See below — this is the one that is
 *     not obvious.
 *
 * ── WHY A LABEL CAN BE REFUSED ─────────────────────────────────────────────
 * Category names are rendered verbatim into the classification prompt, and that
 * prompt goes through `maskSensitiveText`. A label containing an '@', a run of
 * 9+ digits or a PAN-shaped token would be rewritten to `[EMAIL-MASKED]` inside
 * the prompt — so the model would be offered a category whose name is a
 * placeholder, would classify documents into it wrongly or not at all, and
 * nothing anywhere would say why.
 *
 * documentCategories.ts has always stated this constraint for the shipped names.
 * It was never ENFORCED, because until now every name was written by a developer
 * reading that comment. An operator typing into a form is not, so the rule moves
 * from a comment to a check — run as the masker itself, not as a copy of its
 * patterns, so the two cannot drift.
 */
import { maskSensitiveText } from '@/lib/aiPrivacyMasker';
import { isSafeKeyPart } from '@/lib/vault/vaultNaming';

/** Matches `module_key` / `document_key`, and `isSafeKeyPart`'s own ceiling. */
const MAX_KEY_LENGTH = 60;

/**
 * Why a label cannot be used, in the operator's words, or null if it can.
 *
 * Separate from key derivation because the two fail for different reasons and
 * the operator needs to be told which: a label that masks badly needs rewording,
 * a label that slugifies to nothing needs any ASCII at all.
 */
export function labelError(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return 'Give this a name.';

  if (maskSensitiveText(trimmed) !== trimmed) {
    return 'This name looks like personal data (an email address, or a long run of '
      + 'digits) and would be masked out of the AI prompt that classifies documents. '
      + 'Please reword it.';
  }
  return null;
}

/**
 * `"Gift Deed"` → `gift_deed`.
 *
 * `taken` is every key already used in the namespace this key joins — for a
 * sub-category, every documentKey in its module, RETIRED ONES INCLUDED; for a
 * module, every moduleKey there has ever been. The suffix is numeric and
 * appended so the readable part survives.
 *
 * Returns null when the label reduces to nothing (punctuation, emoji, a script
 * with no ASCII), or when the result would not be a safe path segment. The
 * caller turns that into "give this a name using letters or numbers".
 */
export function taxonomyKeyFrom(label: string, taken: Iterable<string>): string | null {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) return null;

  // Room for a two-digit suffix, so uniquifying can never overflow the column.
  const base = slug.slice(0, MAX_KEY_LENGTH - 3).replace(/_+$/, '');
  if (!base) return null;

  const used = new Set(taken);
  const candidates = [base];
  for (let n = 2; n < 100; n += 1) candidates.push(`${base}_${n}`);

  for (const candidate of candidates) {
    if (used.has(candidate)) continue;
    // The storage layer's own rule, not a restatement of it. A slug that fails
    // here is a bug in the slugifier above rather than bad input, but a key that
    // reaches Drive unvalidated is not a class of bug worth trusting away.
    if (!isSafeKeyPart(candidate)) return null;
    return candidate;
  }
  return null;
}
