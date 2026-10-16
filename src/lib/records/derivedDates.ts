/**
 * Dates a document STATES as a period rather than prints as a date.
 *
 * A shop bill says "warranty period is 12 months from the date of purchase"
 * and "exchange within 15 days" — it never prints the day either one ends. The
 * extraction prompt reads the periods into `warranty_months` / `exchange_days`
 * (being told never to do date arithmetic itself), and this computes the end
 * dates from them and the bill date, so the reminders have a date to fire on.
 *
 * An insurance premium works the same way from the other end: a policy schedule
 * or receipt prints when the premium was LAST paid and the mode ("Yly", "Hly"),
 * and the renewal due date is the one after — so `renewal_due_date` is
 * `last_premium_paid_date` plus one interval of `premium_frequency`.
 *
 * Fills a date only when it is BLANK: a date the document actually printed, or
 * the user typed, always wins over a computed one. Pure — its only import is
 * the leaf premiumFrequency table — so the server autofill and anything
 * client-side can share it.
 */
import { PREMIUM_FREQUENCY_MONTHS, normalisePremiumFrequency } from './premiumFrequency';

/** start date key, period key, unit, and the date key it produces. */
const RULES: ReadonlyArray<{
  from: readonly string[];
  period: string;
  unit: 'months' | 'days';
  to: string;
}> = [
  { from: ['issue_date', 'purchase_date'], period: 'warranty_months', unit: 'months', to: 'warranty_expiry' },
  { from: ['issue_date', 'purchase_date'], period: 'exchange_days', unit: 'days', to: 'exchange_until' },
];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIso(value: unknown): Date | null {
  const m = typeof value === 'string' ? ISO_DATE.exec(value.trim()) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `start` plus `n` calendar months, clamped: 31 Jan + 1 month is 28/29 Feb. */
export function addMonths(start: string, n: number): string | null {
  const d = parseIso(start);
  if (!d) return null;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return toIso(target);
}

export function addDays(start: string, n: number): string | null {
  const d = parseIso(start);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

function period(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  // Whole, positive and sane — a misread "120000" months is not a warranty.
  return Number.isInteger(n) && n > 0 && n <= 1200 ? n : null;
}

/**
 * The end dates `fields` implies but does not carry, for the keys `allowed`
 * (the category's spec) — never a key the form has no input for.
 *
 * @returns only the NEW keys; the caller merges them in.
 */
export function deriveDates(
  fields: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of RULES) {
    if (!allowed.has(rule.to)) continue;
    const existing = fields[rule.to];
    if (existing !== undefined && existing !== null && String(existing).trim() !== '') continue;
    const n = period(fields[rule.period]);
    const start = rule.from.map((k) => fields[k]).find((v) => parseIso(v));
    if (n === null || typeof start !== 'string') continue;
    const end = rule.unit === 'months' ? addMonths(start, n) : addDays(start, n);
    if (end) out[rule.to] = end;
  }
  if (allowed.has(RENEWAL_KEY) && isBlank(fields[RENEWAL_KEY])) {
    const next = nextPremiumDue(fields);
    if (next) out[RENEWAL_KEY] = next;
  }
  return out;
}

const RENEWAL_KEY = 'renewal_due_date';

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * The premium due after the last one paid, or null.
 *
 * Null when either half is missing or unreadable, and for a single-premium
 * policy, which has no next premium. Ignores what `renewal_due_date` holds —
 * the caller decides whether a computed date may replace it.
 */
export function nextPremiumDue(fields: Readonly<Record<string, unknown>>): string | null {
  const lastPaid = fields.last_premium_paid_date;
  if (typeof lastPaid !== 'string' || !parseIso(lastPaid)) return null;
  const frequency = normalisePremiumFrequency(fields.premium_frequency);
  const months = frequency ? PREMIUM_FREQUENCY_MONTHS[frequency] : null;
  return months ? addMonths(lastPaid, months) : null;
}
