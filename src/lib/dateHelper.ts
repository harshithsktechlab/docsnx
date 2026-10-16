/**
 * Centralized date helper for DD/MM/YYYY formats
 */

export function formatDate(dateInput: string | Date | number | null | undefined): string {
  if (!dateInput) return '';
  try {
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return '';
    
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    
    return `${day}/${month}/${year}`;
  } catch (error) {
    console.error('Error formatting date:', error);
    return '';
  }
}

export function parseDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  try {
    // Expecting dd/mm/yyyy
    const parts = dateStr.split('/');
    if (parts.length !== 3) {
      // Fallback to standard parsing if it's already yyyy-mm-dd
      const fallback = new Date(dateStr);
      return isNaN(fallback.getTime()) ? null : fallback;
    }
    
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const year = parseInt(parts[2], 10);
    
    const date = new Date(year, month, day);
    return isNaN(date.getTime()) ? null : date;
  } catch (error) {
    console.error('Error parsing date:', error);
    return null;
  }
}

/**
 * A stored `YYYY-MM-DD` as `DD/MM/YYYY`, by string handling alone.
 *
 * Not `formatDate`: `new Date('2026-10-16')` is UTC midnight, which a browser
 * west of Greenwich renders as the 15th. Anything that is not an ISO date is
 * returned unchanged, so a caller can route every value through it.
 */
export function isoToDisplay(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(text);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : text;
}

/**
 * `DD/MM/YYYY` (also `-` or `.` separated, one-digit day/month) as `YYYY-MM-DD`,
 * or null when it is not a real calendar date — `31/02/2026` is refused rather
 * than rolled over into March.
 */
export function displayToIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(String(value).trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
