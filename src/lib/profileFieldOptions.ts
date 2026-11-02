import { z } from 'zod';
import { db } from '@/lib/db';
import { systemConfigs } from '@/db/schema';

/**
 * Dropdown choices for the company profile form, managed by the super admin
 * under Field Config → Company Profile and stored on `system_configs`
 * (`profile_field_options`, migration 0090).
 *
 * NULL / empty / no row all mean "use the built-in list" — the setting only
 * ever overrides, so a platform that never opens the tab still has a sensible
 * dropdown.
 */

/**
 * `registration*` describe the number field that follows the dropdown: what it
 * is called, what to show as an example, and a regex for a warn-only hint.
 * All optional — a choice without them gets a generic "Registration No.".
 */
export type ProfileOption = {
  value: string;
  label: string;
  registrationLabel?: string;
  registrationPlaceholder?: string;
  registrationPattern?: string;
};

const CIN = {
  registrationLabel: 'CIN',
  registrationPlaceholder: 'U74999MH2015PTC123456',
  registrationPattern: '^[LU]\\d{5}[A-Z]{2}\\d{4}[A-Z]{3}\\d{6}$',
};

const entity = (value: string, registration: Partial<ProfileOption> = {}): ProfileOption =>
  ({ value, label: value, ...registration });

export const DEFAULT_ENTITY_TYPES: ProfileOption[] = [
  entity('Private Limited', CIN),
  entity('Public Limited', CIN),
  entity('One Person Company', CIN),
  entity('LLP', {
    registrationLabel: 'LLPIN',
    registrationPlaceholder: 'AAA-1234',
    registrationPattern: '^[A-Z]{3}-\\d{4}$',
  }),
  entity('Partnership Firm', { registrationLabel: 'Firm Registration No.' }),
  entity('Sole Proprietorship', {
    registrationLabel: 'Registration No. (Udyam / Shop & Establishment)',
    registrationPlaceholder: 'UDYAM-MH-00-0000000',
  }),
  entity('HUF', { registrationLabel: 'Registration No. (if any)' }),
  entity('Trust', { registrationLabel: 'Trust Registration No.' }),
  entity('Society', { registrationLabel: 'Society Registration No.' }),
  entity('Section 8 Company', CIN),
  entity('Other', { registrationLabel: 'Registration No.' }),
];

/** Same 200 cap and value/label shape as the document-field choice lists. */
export const ProfileOptionsSchema = z.array(z.object({
  value: z.string().trim().min(1).max(120),
  label: z.string().trim().max(200).optional(),
  registrationLabel: z.string().trim().max(80).optional(),
  registrationPlaceholder: z.string().trim().max(80).optional(),
  registrationPattern: z.string().trim().max(200).optional(),
})).max(200);

/**
 * Trims, defaults a blank label to the value, and rejects duplicate values
 * (case-insensitive — "LLP" and "llp" would be one choice to a person).
 */
export function normalizeOptions(raw: unknown): { ok: true; options: ProfileOption[] } | { ok: false; error: string } {
  const parsed = ProfileOptionsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'Each choice needs a stored value (up to 120 characters), and there can be at most 200.' };
  }
  const seen = new Set<string>();
  const options: ProfileOption[] = [];
  for (const o of parsed.data) {
    const key = o.value.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `“${o.value}” appears more than once.` };
    seen.add(key);
    if (o.registrationPattern) {
      try { new RegExp(o.registrationPattern); } catch {
        return { ok: false, error: `The format for “${o.value}” is not a valid pattern.` };
      }
    }
    const option: ProfileOption = { value: o.value, label: o.label || o.value };
    if (o.registrationLabel) option.registrationLabel = o.registrationLabel;
    if (o.registrationPlaceholder) option.registrationPlaceholder = o.registrationPlaceholder;
    if (o.registrationPattern) option.registrationPattern = o.registrationPattern;
    options.push(option);
  }
  return { ok: true, options };
}

/** What is stored for `entityType`, or null when the super admin has set nothing. */
export async function loadStoredEntityTypes(): Promise<ProfileOption[] | null> {
  const [config] = await db
    .select({ profileFieldOptions: systemConfigs.profileFieldOptions })
    .from(systemConfigs)
    .limit(1);
  const stored = (config?.profileFieldOptions as { entityType?: unknown } | null)?.entityType;
  const checked = normalizeOptions(stored);
  return checked.ok && checked.options.length > 0 ? checked.options : null;
}

/**
 * The effective Entity Type choices. Never throws: a read failure here must
 * not take the whole company profile page down, so it degrades to the defaults.
 */
export async function loadEntityTypeOptions(): Promise<ProfileOption[]> {
  try {
    return (await loadStoredEntityTypes()) ?? DEFAULT_ENTITY_TYPES;
  } catch (err) {
    console.error('[profileFieldOptions] falling back to defaults', err);
    return DEFAULT_ENTITY_TYPES;
  }
}
