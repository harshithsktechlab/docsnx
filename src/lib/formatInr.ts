/**
 * Rupee formatting for the AI cost screens.
 *
 * Indian digit grouping (1,23,456.78) via `en-IN`, the same convention
 * src/app/admin/discounts/page.js uses locally. AI costs are often a few paise,
 * so an amount under ₹1 keeps four decimals — "₹0.00" for a real ₹0.0042 call
 * would read as free.
 */
export function formatInr(value: unknown, opts: { decimals?: number } = {}): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '₹0.00';
  const decimals = opts.decimals ?? (n !== 0 && Math.abs(n) < 1 ? 4 : 2);
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/** Whole numbers with Indian grouping — token and call counts. */
export function formatCount(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-IN') : '0';
}

/** US dollars, four decimals — Gemini's own currency, shown for reconciliation. */
export function formatUsd(value: unknown): string {
  const n = Number(value);
  return `$${(Number.isFinite(n) ? n : 0).toFixed(4)}`;
}
