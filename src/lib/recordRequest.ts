/**
 * Body parsing for record-vault routes that accept an optional attachment.
 *
 * A record can arrive two ways: as JSON (no attachment) or as multipart form
 * data (attachment under the `file` key). Both shapes must be accepted on the
 * same endpoint — the pages only switch to multipart when the user actually
 * picks a file, and older clients post JSON.
 *
 * Multipart values are always strings, so `asBool` / `asJson` coerce the fields
 * that are typed in the JSON path.
 */

export interface RecordRequest {
  fields: Record<string, any>;
  file: File | null;
}

export async function readRecordRequest(req: Request): Promise<RecordRequest> {
  const contentType = req.headers.get('content-type') || '';

  if (!contentType.includes('multipart/form-data')) {
    const body = await req.json();
    return { fields: body || {}, file: null };
  }

  const formData = await req.formData();
  const fields: Record<string, any> = {};
  let file: File | null = null;

  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') {
      fields[key] = value;
    } else if (key === 'file' && value.size > 0) {
      file = value as File;
    }
  }

  return { fields, file };
}

/**
 * The ONE place a holder comes off the wire.
 *
 * Every module route calls this instead of reaching into `fields.holderId`
 * itself. That is the whole point: `investments`, `bank_info` and `trading`
 * each hand-wrote their own body destructure and quietly omitted the field, so
 * three modules could never assign a holder at all. A named helper is
 * greppable; fifteen ad-hoc destructures are not.
 *
 * Returns `undefined` when the client sent no holder field at all — distinct
 * from "All members", and the distinction matters: `resolveHolder` in
 * src/lib/records/handler.ts falls back to the module default only for
 * `undefined`. The sentinels themselves are passed through untouched for it to
 * interpret, so the two ends cannot disagree about what `'all'` means.
 *
 * `isGlobal` is deliberately NOT read here. It is derived from the holder now;
 * a route that still posts it is ignored rather than obeyed.
 */
export function holderFrom(
  source: Record<string, any> | FormData,
): string | null | undefined {
  // FormData is accepted directly because ten routes read multipart without
  // going through `readRecordRequest`. `has()` rather than `get()`: a missing
  // key and an empty one mean different things, and `get()` collapses both to
  // null.
  const raw = source instanceof FormData
    ? (source.has('holderId') ? source.get('holderId') : undefined)
    : (source as Record<string, any>)?.holderId;
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return String(raw);
}

/** Accepts real booleans (JSON path) and `"true"`/`"1"` (multipart path). */
export function asBool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
}

/**
 * Client-side counterpart: encodes a record payload plus its attachment for the
 * multipart branch of `readRecordRequest`. Objects and arrays are JSON-encoded
 * so `asJson` can revive them; `null`/`undefined` fields are omitted.
 */
export function toFormData(payload: Record<string, any>, file: File): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    formData.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  formData.append('file', file);
  return formData;
}

/** Accepts an already-parsed value (JSON path) and a JSON string (multipart path). */
export function asJson<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
