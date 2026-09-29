/**
 * Multi-value list filters.
 *
 * A filter dropdown that accepts several choices sends them as ONE
 * comma-separated query param (`?moduleKey=vehicle,insurance`) rather than as a
 * repeated key: `parseQueryParams` (src/lib/api-pagination.ts) folds a repeated
 * key with last-wins, so `?a=1&a=2` would silently drop the first value.
 *
 * Splitting is the route's job — this is the one place that decides what a
 * comma-separated filter means, so a single-value caller and a multi-value one
 * cannot disagree about blanks, spacing or duplicates.
 */

/**
 * The distinct values a filter param carries, in the order they were sent.
 *
 * Blank entries are dropped rather than passed through: an `inArray` with an
 * empty string in it matches nothing, which reads as "the filter is broken"
 * instead of "the trailing comma meant nothing".
 */
export function splitFilterValues(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}
