/**
 * Premium frequency ("mode of payment") — the one choice field whose answer
 * drives a date.
 *
 * Indian policy schedules print the mode in a handful of house abbreviations —
 * LIC's "Yly", "Hly", "Qly", "Mly", "SSS" (salary savings, monthly) — and
 * records saved before this became a `select` hold whatever the document said.
 * `normalisePremiumFrequency` folds both onto the option values, so an AI answer
 * is not dropped by `asChoice` and an old record is not refused by the select
 * validator the next time it is saved.
 *
 * Bare numbers ("12", "6") are deliberately not aliases: "12" is as often
 * "12 instalments a year" as "every 12 months".
 *
 * Pure and leaf — no imports — so the server autofill, the derived-dates rule
 * and the client form can all share it.
 */

export const PREMIUM_FREQUENCY_OPTIONS = [
  { value: 'yearly', label: 'Yearly' },
  { value: 'half_yearly', label: 'Half-Yearly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'single', label: 'Single Premium' },
] as const;

export type PremiumFrequency = (typeof PREMIUM_FREQUENCY_OPTIONS)[number]['value'];

/** Months between two premiums. `single` has no next one. */
export const PREMIUM_FREQUENCY_MONTHS: Readonly<Record<PremiumFrequency, number | null>> = {
  yearly: 12,
  half_yearly: 6,
  quarterly: 3,
  monthly: 1,
  single: null,
};

/** Folded spelling → option value. Folded = lower-case, letters and digits only. */
const ALIASES: Readonly<Record<string, PremiumFrequency>> = {
  yearly: 'yearly', yly: 'yearly', annual: 'yearly', annually: 'yearly', yearlymode: 'yearly',
  y: 'yearly', a: 'yearly', peryear: 'yearly',
  halfyearly: 'half_yearly', hly: 'half_yearly', halfyly: 'half_yearly', semiannual: 'half_yearly',
  semiannually: 'half_yearly', biannual: 'half_yearly', sixmonthly: 'half_yearly',
  h: 'half_yearly', hy: 'half_yearly',
  quarterly: 'quarterly', qly: 'quarterly', qtly: 'quarterly', qtrly: 'quarterly',
  q: 'quarterly',
  monthly: 'monthly', mly: 'monthly', sss: 'monthly', ecs: 'monthly', nach: 'monthly', m: 'monthly',
  permonth: 'monthly',
  single: 'single', singlepremium: 'single', sp: 'single', onetime: 'single',
  lumpsum: 'single',
};

/** A frequency however it is spelled, as its option value — or null if unrecognised. */
export function normalisePremiumFrequency(value: unknown): PremiumFrequency | null {
  if (value === null || value === undefined) return null;
  const folded = String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  return folded ? ALIASES[folded] ?? null : null;
}
