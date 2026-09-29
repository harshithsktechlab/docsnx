/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE SUB-CATEGORY FORM'S BODY, READ ONCE                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `POST /api/modules/:moduleKey/:documentKey` and
 * `PUT  /api/modules/:moduleKey/:documentKey/:id` are the same form submitted
 * twice — once for a record that does not exist yet and once for one that does.
 * They therefore have to agree on every rule about the payload, and the two
 * that matter most are easy to write once and forget once:
 *
 *  · THE SPEC IS THE ALLOWLIST. A key the category does not declare was never
 *    rendered as an input, so accepting one would store a field no encryption
 *    policy classifies — and an unclassified field is an unsealed one.
 *  · THE FILE TYPE IS CHECKED SERVER-SIDE. `accept` on the picker is a hint.
 *
 * Hand-rolling that twice is how an edit route ends up accepting what its
 * create sibling refuses. This module is the one reading of the body; the
 * routes decide only what to do with the result.
 */
import { db } from '@/lib/db';
import type { CategoryKey } from '@/lib/documentCategories';
import { loadCategoryFieldSpec } from '@/lib/records/categorySpec';
import type { FieldSpec } from '@/lib/documentCategoryFields';
import {
  CUSTOM_FIELDS_KEY,
  type FieldErrors,
  formFields,
  isBlank,
  normaliseCustomFields,
  validateRecord,
} from '@/lib/records/fieldValidation';
import { LINKED_CARDS_KEY, normaliseLinkedCards } from '@/lib/records/linkedCards';
import { readRecordRequest, holderFrom } from '@/lib/recordRequest';
import {
  isAcceptedUpload, isWithinUploadSize, uploadSizeError, uploadTypeError,
} from '@/lib/records/uploadTypes';
import { refreshUploadLimit } from '@/lib/records/uploadLimitLoader';

export interface CategoryFormBody {
  /** The record's name. Empty only when `fieldErrors` already says so. */
  title: string;
  /** Taxonomy keys the category declares, blanks dropped. */
  record: Record<string, unknown>;
  /** `undefined` means the form sent no holder at all — a bug in the form. */
  holderId: string | null | undefined;
  file: File | null;
  /**
   * The caller answered the duplicate prompt with "keep the new one". It means
   * "update the record this duplicates", NOT "save a second copy" — forking is
   * `keepBoth` below and nothing else. Still posted as `forceSave` on the wire,
   * so the six legacy pages that send it need no change.
   */
  overwrite: boolean;
  /**
   * The caller answered it with "keep both": file this as a SEPARATE record
   * beside the one it matched, under a numbered title.
   *
   * A distinct field rather than a value of `forceSave` on purpose — the six
   * legacy pages post `forceSave` and mean overwrite, and a shared field would
   * make the meaning depend on which page sent it. `createRecord` still refuses
   * this answer for a match on a declared identifier.
   */
  keepBoth: boolean;
  splitPages: boolean;
  /** Field key → message. Non-empty means the request must be refused. */
  fieldErrors: Record<string, string>;
  /** `userId` as posted, for routes that let an admin file on someone's behalf. */
  ownerId: string | null;
}

/**
 * A submitted field bag → the record body, with the spec as the allowlist.
 *
 * The three rules that make a form payload safe to store, in one place:
 *
 *  1. THE SPEC IS THE ALLOWLIST. A key the category does not declare is
 *     dropped. Every key a form may legitimately send was rendered from this
 *     same list, and a key no encryption policy classifies is an UNSEALED one —
 *     which is the whole reason this is not a spread of `fields`.
 *  2. The user's own label/value rows are sealed under the baseline
 *     `custom_fields` key, as JSON TEXT. The encrypt policy names a key, so a
 *     nested object would leave the labels in the clear beside sealed values.
 *  3. Validation runs here, so the browser and the route produce the same
 *     sentences under the same keys — over the fields a form RENDERS, which is
 *     not the same list as the allowlist. See below.
 *
 * Exported because the Documents Manager posts a taxonomy-keyed body to
 * `POST /api/documents` — a different route, a different request shape, the
 * same three rules. Restating them there is how one route ends up accepting
 * what its sibling refuses.
 */
export function buildTaxonomyRecord(
  specs: readonly FieldSpec[],
  fields: Record<string, unknown>,
): { record: Record<string, unknown>; fieldErrors: FieldErrors } {
  const record: Record<string, unknown> = {};
  for (const spec of specs) {
    const value = fields[spec.fieldKey];
    if (!isBlank(value)) record[spec.fieldKey] = typeof value === 'string' ? value.trim() : value;
  }

  const custom = normaliseCustomFields(fields[CUSTOM_FIELDS_KEY]);
  if (custom) record[CUSTOM_FIELDS_KEY] = JSON.stringify(custom);

  /**
   * The linked cards, by the same rule and for the same reason: a list stored
   * as JSON TEXT under one sealed key, because the encrypt policy names a key
   * and a nested object would leave the card holder's name in the clear beside
   * a sealed card number.
   *
   * Deleted when nothing survives rather than stored as an empty box — the loop
   * above already copied whatever the form sent, which for a user who removed
   * their last card is `{"cards":[]}`, and that is not the same thing as the
   * field being empty.
   */
  const cards = normaliseLinkedCards(fields[LINKED_CARDS_KEY]);
  if (cards) record[LINKED_CARDS_KEY] = cards;
  else delete record[LINKED_CARDS_KEY];

  /**
   * ── THE ALLOWLIST IS THE WHOLE SPEC; WHAT IS JUDGED IS NOT ────────────────
   *
   * The loop above keeps every key the category declares, `holder_name` and
   * `custom_fields` included — they are stored, sealed and read back as they
   * always were. `formFields` only decides what may FAIL.
   *
   * Validating the whole spec meant a super admin could mark either of those
   * two required on /admin/document-fields and make the category unsavable
   * through every route at once, since neither is rendered as an input and the
   * form had nowhere to show the message. `<CategoryRecordForm>` already
   * validated the visible list for exactly this reason; the server did not, so
   * the browser passed the record and the route answered 400 on a field that
   * was nowhere on screen. One list now, in fieldValidation.ts, read by both.
   */
  return { record, fieldErrors: validateRecord(formFields(specs), record) };
}

export async function readCategoryFormBody(
  req: Request,
  categoryKey: CategoryKey,
): Promise<CategoryFormBody> {
  const { fields, file } = await readRecordRequest(req);
  const specs = await loadCategoryFieldSpec(db, categoryKey);
  await refreshUploadLimit();

  const { record, fieldErrors } = buildTaxonomyRecord(specs, fields);

  // "Belongs to" is mandatory on this form — a member, or the explicit "All
  // members". `holderFrom` returns undefined only when the client sent no holder
  // field at all, which for this page is a bug in the form, not a record that
  // belongs to nobody.
  const holderId = holderFrom(fields);
  if (holderId === undefined) {
    fieldErrors.holderId = 'Choose who this record belongs to';
  }

  const title = String(fields.title ?? record.document_title ?? '').trim();
  if (!title) {
    fieldErrors.document_title = fieldErrors.document_title ?? 'Give this record a title';
  }

  // A refused type is a field error rather than a bare 400 so it lands on the
  // file control instead of arriving as a banner with no obvious cause.
  if (file && !isAcceptedUpload(file)) {
    fieldErrors.file = uploadTypeError(file);
  } else if (file && !isWithinUploadSize(file)) {
    // `else if` so an oversized file of a refused type reports the type — that
    // is the one the user has to fix first, and two messages on one control
    // read as two problems.
    fieldErrors.file = uploadSizeError(file);
  }

  return {
    title,
    record,
    holderId,
    file,
    overwrite: fields.forceSave === 'true' || fields.forceSave === true,
    keepBoth: fields.keepBoth === 'true' || fields.keepBoth === true,
    splitPages: fields.splitPages === 'true' || fields.splitPages === true,
    fieldErrors,
    ownerId: typeof fields.userId === 'string' ? fields.userId : null,
  };
}
