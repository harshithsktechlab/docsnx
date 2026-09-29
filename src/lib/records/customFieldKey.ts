/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   NAMING A FIELD AN OPERATOR INVENTED                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A custom field's `fieldKey` is generated here, on the server, from the label
 * the operator typed. It is never accepted from the client, for the same reason
 * the dictionary's keys are never edited: the key is what already-sealed
 * ciphertext is stored under, and a caller that can choose it can choose one
 * that collides with a dictionary field and quietly take over its data.
 *
 * ── WHY THE `cf_` PREFIX ───────────────────────────────────────────────────
 * It partitions the namespace. Nothing in the 526-entry dictionary starts with
 * it, so a field added today cannot be broken by a field added to
 * documentCategoryFields.ts tomorrow — which matters because the two are
 * maintained by different people at different times and neither can see the
 * other's plans.
 *
 * `cf_` rather than `custom_`: `custom_fields` is a BASELINE key on every
 * category, so a `custom_` prefix would collide with it the first time somebody
 * created a field called "Fields".
 *
 * ── THE FORBIDDEN-WORD GUARD IS THE SHARP PART ─────────────────────────────
 * `prepareAiPayload` deletes any key whose folded name contains one of its
 * credential words. An OPEN field called "Login PIN" would therefore vanish
 * from every AI payload, silently, with nothing on any screen to say why. So a
 * key that trips the list is refused unless the field is sealed — the same rule
 * tests/documentCategoryFields.test.ts already enforces for the shipped fields.
 */

/** The prefix that partitions operator-created keys from the dictionary's. */
export const CUSTOM_FIELD_PREFIX = 'cf_';

/** Matches the `field_key` column. */
const MAX_KEY_LENGTH = 100;

/**
 * The credential words `prepareAiPayload` strips, folded.
 *
 * Duplicated from src/lib/aiPrivacyMasker.ts deliberately: that list is the
 * enforcement point and must not grow a dependency on this file, and this is a
 * PRE-flight that refuses the name before a row exists. A word added there and
 * not here costs a warning at creation time, not a leak — the masker still
 * strips the key. tests assert the two stay in step.
 */
const CREDENTIAL_WORDS = [
  'password', 'passwordencrypted', 'passwordhash', 'netbankingusername',
  'cards', 'cvv', 'pin', 'secretkey', 'apikey', 'loginusername',
  'clientsecret', 'token', 'authcode', 'secret', 'privatekey', 'passphrase',
];

/** Bare lowercase alphanumerics — the same fold `prepareAiPayload` applies. */
const fold = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Does this key name something `prepareAiPayload` would strip?
 *
 * Mirrors the masker's own two-tier rule: short words must line up with a word
 * boundary of the original key (so `upi_pin` matches and `cin_or_llpin` does
 * not), long ones match anywhere.
 */
export function tripsCredentialFilter(fieldKey: string): string | null {
  const folded = fold(fieldKey);
  const words = fieldKey.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  for (const word of CREDENTIAL_WORDS) {
    if (word.length <= 4) {
      if (words.some((w) => w === word)) return word;
    } else if (folded.includes(word)) {
      return word;
    }
  }
  return null;
}

/**
 * `"Agent's Email Address"` → `cf_agent_s_email_address`.
 *
 * `taken` is every key the category already carries — dictionary and custom
 * alike — so two fields can share a label without sharing a key. The suffix is
 * numeric and appended, never inserted, so the readable part survives.
 *
 * Returns null when the label reduces to nothing (punctuation, emoji, a script
 * with no ASCII). The caller turns that into "give this field a name" rather
 * than storing `cf_`.
 */
export function customFieldKey(label: string, taken: Iterable<string>): string | null {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) return null;

  // Room for a two-digit suffix, so uniquifying can never overflow the column.
  const base = `${CUSTOM_FIELD_PREFIX}${slug}`.slice(0, MAX_KEY_LENGTH - 3);
  const used = new Set(taken);
  if (!used.has(base)) return base;

  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

/** Was this key created by an operator rather than shipped in the dictionary? */
export function isCustomFieldKey(fieldKey: string): boolean {
  return fieldKey.startsWith(CUSTOM_FIELD_PREFIX);
}
