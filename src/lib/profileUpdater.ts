import { db } from './db';
import { profiles } from '../db/schema';
import { eq } from 'drizzle-orm';
import { encryptField, decryptField } from './fieldCrypto';

// Legal identifiers stored in profiles.legalDetails are encrypted at rest.
const LEGAL_ENCRYPTED_KEYS = ['panNumber', 'aadhaarNumber', 'passportNumber'];

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
      const docName = (data.name || '').toLowerCase();
      const meta = data.metadata || {};

      // If document contains details in metadata
      if (docName.includes('pan')) {
        setIfNew(legalDetails, 'panNumber', meta.documentNumber);
        if (meta.dob) setIfNew(personalDetails, 'dob', meta.dob);
      } else if (docName.includes('aadhaar')) {
        setIfNew(legalDetails, 'aadhaarNumber', meta.documentNumber);
        if (meta.dob) setIfNew(personalDetails, 'dob', meta.dob);
      } else if (docName.includes('passport')) {
        setIfNew(legalDetails, 'passportNumber', meta.documentNumber);
        if (meta.dob) setIfNew(personalDetails, 'dob', meta.dob);
      }

      // Check custom fields
      if (Array.isArray(meta.customFields)) {
        for (const f of meta.customFields) {
          const lbl = (f.label || '').toLowerCase();
          const val = f.value;
          if (lbl.includes('blood') || lbl.includes('blood group')) {
            setIfNew(personalDetails, 'bloodGroup', val);
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
        setIfNew(personalDetails, 'bloodGroup', match[0].toUpperCase());
      }

      // Parse custom fields
      if (Array.isArray(data.customFields)) {
        for (const f of data.customFields) {
          const lbl = (f.label || '').toLowerCase();
          const val = f.value;
          if (lbl.includes('blood') || lbl.includes('blood group')) {
            setIfNew(personalDetails, 'bloodGroup', val);
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
            setIfNew(personalDetails, 'bloodGroup', val);
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
