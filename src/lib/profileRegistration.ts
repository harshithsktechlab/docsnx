/**
 * The registration-number field that follows Entity Type on the company
 * profile. Pure and client-safe — no database import — so the form can use it.
 *
 * Which number a company has depends on what it is: a CIN for a company, an
 * LLPIN for an LLP, a firm or trust number otherwise. The labels, examples and
 * formats come from the entity type option the super admin manages in Field
 * Config → Company Profile; this only reads them. The format is a hint, never a
 * gate — older and unusual numbers exist, so nothing here blocks a save.
 */

type RegistrationOption = {
  registrationLabel?: string;
  registrationPlaceholder?: string;
  registrationPattern?: string;
} | null | undefined;

export const GENERIC_REGISTRATION_LABEL = 'Registration No.';

export function registrationFieldFor(option: RegistrationOption): { label: string; placeholder: string } {
  return {
    label: option?.registrationLabel || GENERIC_REGISTRATION_LABEL,
    placeholder: option?.registrationPlaceholder || '',
  };
}

/** A warning when the value doesn't fit the type's format, else null. */
export function registrationHint(option: RegistrationOption, value: string): string | null {
  const pattern = option?.registrationPattern;
  const v = (value || '').trim().toUpperCase();
  if (!pattern || !v) return null;
  try {
    if (new RegExp(pattern).test(v)) return null;
  } catch {
    return null;
  }
  const { label, placeholder } = registrationFieldFor(option);
  return placeholder
    ? `This doesn't look like a ${label} (expected something like ${placeholder}). You can still save it.`
    : `This doesn't look like a ${label}. You can still save it.`;
}
