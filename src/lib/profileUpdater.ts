import { db } from './db';
import { profiles } from '../db/schema';
import { eq } from 'drizzle-orm';
import { encryptField, decryptField } from './fieldCrypto';
import { normaliseBloodGroup } from './profileValues';

// Legal identifiers stored in profiles.legalDetails are encrypted at rest.
const LEGAL_ENCRYPTED_KEYS = ['panNumber', 'aadhaarNumber', 'passportNumber'];

/**
 * The personal ID documents whose number the profile's Legal / ID tab mirrors.
 *
 * Keyed on the `identity` pair, never on `documentKey` alone: `pan_card` also
 * exists under `biz_registration`, and a company's PAN is not the member's.
 */
export const PROFILE_ID_DOCUMENTS = {
  pan: { documentKey: 'pan_card', fieldKey: 'pan_number', legalKey: 'panNumber', title: 'PAN Card' },
  aadhaar: { documentKey: 'aadhaar_card', fieldKey: 'aadhaar_number', legalKey: 'aadhaarNumber', title: 'Aadhaar Card' },
  passport: { documentKey: 'passport', fieldKey: 'passport_number', legalKey: 'passportNumber', title: 'Passport' },
} as const;
export type ProfileIdKind = keyof typeof PROFILE_ID_DOCUMENTS;
export const PROFILE_ID_MODULE_KEY = 'identity';

/** Same shapes the profile's own inputs accept: uppercase PAN/passport, digits-only Aadhaar. */
export function normaliseIdNumber(kind: ProfileIdKind, value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return kind === 'aadhaar' ? raw.replace(/[^0-9]/g, '') : raw.replace(/\s+/g, '').toUpperCase();
}

/** Which profile ID a document is, or null when it is not one of them. */
export function profileIdKindFor(moduleKey?: string | null, documentKey?: string | null): ProfileIdKind | null {
  if (moduleKey !== PROFILE_ID_MODULE_KEY) return null;
  for (const [kind, def] of Object.entries(PROFILE_ID_DOCUMENTS)) {
    if (def.documentKey === documentKey) return kind as ProfileIdKind;
  }
  return null;
}

/**
 * Write one ID number into a member's profile, creating the profile if needed.
 * Returns true when the stored value changed.
 */
export async function applyIdNumberToProfile(userId: string, kind: ProfileIdKind, value: unknown): Promise<boolean> {
  const number = normaliseIdNumber(kind, value);
  if (!userId || !number) return false;
  const legalKey = PROFILE_ID_DOCUMENTS[kind].legalKey;

  const profile = await db.query.profiles.findFirst({
    where: (profiles, { eq }) => eq(profiles.userId, userId),
  });
  const legalDetails = { ...((profile?.legalDetails as object) || {}) } as any;
  const current = legalDetails[legalKey] ? decryptField(legalDetails[legalKey]) : '';
  if (current === number) return false;
  legalDetails[legalKey] = encryptField(number);

  if (profile) {
    await db.update(profiles)
      .set({ legalDetails, updatedAt: new Date() })
      .where(eq(profiles.userId, userId));
  } else {
    await db.insert(profiles).values({
      userId,
      personalDetails: {},
      educationDetails: {},
      shoppingDetails: {},
      legalDetails,
    });
  }
  return true;
}

/**
 * Automatically update user profile details based on structured inputs
 * and document metadata.
 * 
 * @param {string} userId - The user ID whose profile is to be updated
 * @param {string} category - The category of record ("document", "medical", "bank", etc.)
 * @param {any} data - The record data that was created or updated
 */
export async function autoUpdateProfile(userId: string, category: string, data: any) {
  if (!userId) return;

  try {
    // Personal ID documents (PAN / Aadhaar / passport). Matched on the record's
    // category pair, and the number read under the category's own field key —
    // with the legacy `documentNumber` for bodies still in the camelCase
    // vocabulary. The number lands on the HOLDER's profile: an Aadhaar filed for
    // a spouse is the spouse's. A global ("all members") or company record is
    // nobody's in particular, so it updates no profile.
    if (category === 'document') {
      const kind = profileIdKindFor(data?.categoryModuleKey, data?.categoryDocumentKey);
      if (kind) {
        if (!data.companyId && !data.isGlobal) {
          const meta = data.metadata || {};
          const number = meta[PROFILE_ID_DOCUMENTS[kind].fieldKey] ?? meta.documentNumber;
          const changed = await applyIdNumberToProfile(data.holderId || userId, kind, number);
          if (changed) console.log(`Auto-updated profile ${kind} number from a saved document.`);
        }
        return;
      }
    }

    // 1. Fetch current profile or create an empty one
    let profile = await db.query.profiles.findFirst({
      where: (profiles, { eq }) => eq(profiles.userId, userId)
    });

    if (!profile) {
      const [newProfile] = await db.insert(profiles).values({
        userId,
        personalDetails: {},
        educationDetails: {},
        shoppingDetails: {},
        legalDetails: {}
      }).returning();
      profile = newProfile;
    }

    const personalDetails = { ...(profile.personalDetails as object || {}) } as any;
    const educationDetails = { ...(profile.educationDetails as object || {}) } as any;
    const shoppingDetails = { ...(profile.shoppingDetails as object || {}) } as any;
    const legalDetails = { ...(profile.legalDetails as object || {}) } as any;

    // Work with plaintext legal IDs internally; they are re-encrypted before save.
    for (const k of LEGAL_ENCRYPTED_KEYS) {
      if (legalDetails[k]) legalDetails[k] = decryptField(legalDetails[k]);
    }

    let updated = false;

    // Helper to set value if not empty and changed
    const setIfNew = (obj: any, key: string, val: any) => {
      if (val !== undefined && val !== null && val !== '') {
        const valStr = String(val).trim();
        if (valStr && obj[key] !== valStr) {
          obj[key] = valStr;
          updated = true;
        }
      }
    };

    // 2. Parse based on category
    if (category === 'document') {
      // ID numbers are handled above, by category; only the free-form custom
      // fields are read here.
      const meta = data.metadata || {};

      // Check custom fields
      if (Array.isArray(meta.customFields)) {
        for (const f of meta.customFields) {
          const lbl = (f.label || '').toLowerCase();
          const val = f.value;
          if (lbl.includes('blood') || lbl.includes('blood group')) {
            setIfNew(personalDetails, 'bloodGroup', normaliseBloodGroup(val));
          } else if (lbl.includes('gender')) {
            setIfNew(personalDetails, 'gender', val.toLowerCase());
          } else if (lbl.includes('birth place') || lbl.includes('place of birth')) {
            setIfNew(personalDetails, 'birthPlace', val);
          } else if (lbl.includes('degree') || lbl.includes('education')) {
            setIfNew(educationDetails, 'degree', val);
          } else if (lbl.includes('college') || lbl.includes('university') || lbl.includes('school')) {
            setIfNew(educationDetails, 'college', val);
          } else if (lbl.includes('passing year') || lbl.includes('year of passing') || lbl.includes('graduated')) {
            setIfNew(educationDetails, 'yearOfPassing', val);
          } else if (lbl.includes('shirt') || lbl.includes('clothing') || lbl.includes('tshirt')) {
            setIfNew(shoppingDetails, 'clothingSize', val);
          } else if (lbl.includes('shoe')) {
            setIfNew(shoppingDetails, 'shoeSize', val);
          }
        }
      }
    } else if (category === 'medical') {
      // Extract from details
      const details = (data.details || '').toLowerCase();
      const bloodGroupRegex = /\b(a|b|ab|o)[+-](ve)?\b/i;
      const match = details.match(bloodGroupRegex);
      if (match) {
        setIfNew(personalDetails, 'bloodGroup', normaliseBloodGroup(match[0].toUpperCase()));
      }

      // Parse custom fields
      if (Array.isArray(data.customFields)) {
        for (const f of data.customFields) {
          const lbl = (f.label || '').toLowerCase();
          const val = f.value;
          if (lbl.includes('blood') || lbl.includes('blood group')) {
            setIfNew(personalDetails, 'bloodGroup', normaliseBloodGroup(val));
          } else if (lbl.includes('dob') || lbl.includes('birth')) {
            setIfNew(personalDetails, 'dob', val);
          } else if (lbl.includes('gender')) {
            setIfNew(personalDetails, 'gender', val.toLowerCase());
          }
        }
      }
    } else {
      // General check on any record's custom fields
      if (Array.isArray(data.customFields)) {
        for (const f of data.customFields) {
          const lbl = (f.label || '').toLowerCase();
          const val = f.value;
          if (lbl.includes('pan number') || lbl.includes('pan card') || lbl.includes('pan no')) {
            setIfNew(legalDetails, 'panNumber', val.toUpperCase());
          } else if (lbl.includes('aadhaar')) {
            setIfNew(legalDetails, 'aadhaarNumber', val);
          } else if (lbl.includes('passport')) {
            setIfNew(legalDetails, 'passportNumber', val.toUpperCase());
          } else if (lbl.includes('dob') || lbl.includes('date of birth')) {
            setIfNew(personalDetails, 'dob', val);
          } else if (lbl.includes('blood')) {
            setIfNew(personalDetails, 'bloodGroup', normaliseBloodGroup(val));
          } else if (lbl.includes('gender')) {
            setIfNew(personalDetails, 'gender', val.toLowerCase());
          } else if (lbl.includes('degree')) {
            setIfNew(educationDetails, 'degree', val);
          } else if (lbl.includes('college') || lbl.includes('university')) {
            setIfNew(educationDetails, 'college', val);
          }
        }
      }
    }

    // 3. Save if updated
    if (updated) {
      // Encrypt legal identifiers before persisting.
      const legalDetailsToSave = { ...legalDetails };
      for (const k of LEGAL_ENCRYPTED_KEYS) {
        if (legalDetailsToSave[k]) legalDetailsToSave[k] = encryptField(legalDetailsToSave[k]);
      }
      await db.update(profiles)
        .set({
          personalDetails,
          educationDetails,
          shoppingDetails,
          legalDetails: legalDetailsToSave
        })
        .where(eq(profiles.userId, userId));
      console.log(`Auto-updated profile for user ${userId} based on saved ${category} data.`);
    }
  } catch (err) {
    console.error(`Failed to auto-update profile for user ${userId}:`, err);
  }
}
