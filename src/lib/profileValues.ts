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
