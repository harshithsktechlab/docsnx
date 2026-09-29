/**
 * Display-side data masking for sensitive fields.
 *
 * Used on list/collection API responses so the server can decrypt a value but
 * only return a masked form. The full plaintext is returned only from
 * single-record ("reveal") endpoints, which are permission-gated.
 *
 * All maskers are null-safe and return '' for empty input.
 */

const DOT = '•'; // •

/** Show only the last `keep` characters: "1234567890" -> "••••7890". */
export function maskTail(value: string | null | undefined, keep = 4): string {
  if (!value) return '';
  const str = String(value);
  if (str.length <= keep) return DOT.repeat(Math.max(str.length, 4));
  return DOT.repeat(4) + str.slice(-keep);
}

/** Card number -> "•••• •••• •••• 1234". Accepts spaced or unspaced input. */
export function maskCard(value: string | null | undefined): string {
  if (!value) return '';
  const digits = String(value).replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return `${DOT.repeat(4)} ${DOT.repeat(4)} ${DOT.repeat(4)} ${last4 || DOT.repeat(4)}`;
}

/** CVV is never returned. Always renders as fixed dots. */
export function maskCvv(): string {
  return DOT.repeat(3);
}

/** Username/login -> first 2 chars then dots: "raghav" -> "ra••••". */
export function maskUsername(value: string | null | undefined): string {
  if (!value) return '';
  const str = String(value);
  if (str.length <= 2) return DOT.repeat(4);
  return str.slice(0, 2) + DOT.repeat(Math.max(str.length - 2, 4));
}

/** Email -> "ra•••@gmail.com" (masks the local part, keeps the domain). */
export function maskEmail(value: string | null | undefined): string {
  if (!value) return '';
  const str = String(value);
  const at = str.indexOf('@');
  if (at <= 0) return maskUsername(str);
  const local = str.slice(0, at);
  const domain = str.slice(at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${DOT.repeat(4)}${domain}`;
}

/** Phone -> keep last 4 digits: "+919876543210" -> "••••3210". */
export function maskPhone(value: string | null | undefined): string {
  if (!value) return '';
  const digits = String(value).replace(/\D/g, '');
  return maskTail(digits, 4);
}

/** Generic ID/document number -> keep last 4: Aadhaar/PAN/policy etc. */
export function maskDocId(value: string | null | undefined): string {
  return maskTail(value, 4);
}

/**
 * Apply a map of `{ fieldName: maskFn }` to a plain object (returns a copy).
 * Fields not present are ignored. Use after decrypting for list responses.
 */
export function maskFields<T extends Record<string, any>>(
  obj: T,
  masks: Partial<Record<keyof T, (v: any) => string>>
): T {
  if (!obj) return obj;
  const out: Record<string, any> = { ...obj };
  for (const key of Object.keys(masks) as (keyof T)[]) {
    if (key in out && out[key as string] !== null && out[key as string] !== undefined) {
      const fn = masks[key]!;
      out[key as string] = fn(out[key as string]);
    }
  }
  return out as T;
}
