/**
 * Fixed vocabularies for the profile's Personal tab, and the readers that map
 * older free-text values onto them.
 */

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

/**
 * One of BLOOD_GROUPS for anything a person or a document might have written —
 * "O -ve", "o+ve", "AB positive", "B NEG" — or '' when it names none of them.
 */
export function normaliseBloodGroup(value: unknown): string {
  const text = String(value ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  const m = text.match(/^(AB|A|B|O)\s*(\+|-|POS(?:ITIVE)?|NEG(?:ATIVE)?|\+\s*VE|-\s*VE)?$/);
  if (!m || !m[2]) return '';
  const sign = m[2].startsWith('+') || m[2].startsWith('POS') ? '+' : '-';
  return `${m[1]}${sign}`;
}

/**
 * A blood group named in free text — a lab report's results, a diagnosis — or
 * ''. Only a value labelled "blood group" counts: a bare "A+" in a report is as
 * likely to be a grade as a blood type.
 */
export function bloodGroupFromText(text: unknown): string {
  const m = String(text ?? '').match(
    /blood\s*group(?:\s*\(?\s*abo\s*(?:\/|&|and)?\s*rh\s*\)?)?\s*[:\-=]?\s*(AB|A|B|O)\s*(\+\s*ve|-\s*ve|\+|-|positive|negative|pos|neg)/i,
  );
  return m ? normaliseBloodGroup(`${m[1]}${m[2]}`) : '';
}

/**
 * A date of birth as the profile's `<input type="date">` holds it (YYYY-MM-DD),
 * from what a card or the AI might give: ISO (with or without a time),
 * DD/MM/YYYY, DD-MM-YYYY or DD.MM.YYYY. '' for anything else or an impossible
 * date — a wrong DOB saved silently is worse than a blank one.
 */
export function normaliseDob(value: unknown): string {
  const text = String(value ?? '').trim();
  let y: number; let mo: number; let d: number;
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    m = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
    if (!m) return '';
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return '';
  if (y < 1900 || date.getTime() > Date.now()) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** One of the profile's gender values (male / female / other), or ''. */
export function normaliseGender(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase();
  if (['m', 'male', 'man'].includes(text)) return 'male';
  if (['f', 'female', 'woman'].includes(text)) return 'female';
  if (['t', 'o', 'other', 'others', 'transgender', 'third gender'].includes(text)) return 'other';
  return '';
}

export interface IndiaPlaces {
  states: { code: string; name: string }[];
  /** [city name, state code] */
  cities: [string, string][];
}

/**
 * Read a free-text place of birth ("Mumbai, India", "Pune, Maharashtra",
 * "Kolkata") as a city and state from the list. Returns nulls for the parts
 * that do not match, so the caller can keep the original text as a hint.
 */
export function parseBirthPlace(
  text: string,
  places: IndiaPlaces,
): { city: string | null; state: string | null } {
  const parts = String(text || '').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return { city: null, state: null };

  const stateByName = new Map(places.states.map((s) => [s.name.toLowerCase(), s]));
  const state = parts.slice(1).map((p) => stateByName.get(p)).find(Boolean)
    ?? (parts.length === 1 ? stateByName.get(parts[0]) : undefined)
    ?? null;

  const cityName = parts[0];
  const candidates = places.cities.filter(([name]) => name.toLowerCase() === cityName);
  const match = (state ? candidates.find(([, code]) => code === state.code) : null)
    ?? (candidates.length === 1 ? candidates[0] : null);

  if (match) {
    const matchState = places.states.find((s) => s.code === match[1]) ?? null;
    return { city: match[0], state: matchState?.name ?? null };
  }
  return { city: null, state: state?.name ?? null };
}
