/**
 * AI Privacy Shield & Token Optimizer
 *
 * Anonymizes sensitive PII in the browser before sending prompts to AI models
 * (Gemini/OpenAI), compresses verbose payloads to optimize token usage, and
 * enforces the Zero-Credentials safety barrier.
 */

export interface MaskedPayload {
  sanitizedPrompt: string;
  sanitizedData: Record<string, any>;
  tokenReductionPercentEstimate: number;
}

const PII_PATTERNS = [
  // Indian Aadhaar Number (12 digits)
  { regex: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, mask: '[AADHAAR-MASKED]' },
  // Indian PAN Number (5 letters, 4 digits, 1 letter)
  { regex: /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/gi, mask: '[PAN-MASKED]' },
  // Bank Account Numbers (9 to 18 digits)
  { regex: /\b\d{9,18}\b/g, mask: '[ACCOUNT-NUM-MASKED]' },
  // Email addresses inside free text
  { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g, mask: '[EMAIL-MASKED]' },
  // Phone numbers (+91 or 10 digits)
  { regex: /(?:\+?91[\-\s]?)?[6-9]\d{9}\b/g, mask: '[PHONE-MASKED]' },
];

/**
 * Sanitizes free text by masking Aadhaar, PAN, Bank Accounts, Phone Numbers, and Emails.
 */
export function maskSensitiveText(input: string): string {
  if (!input) return '';
  let sanitized = input;
  for (const { regex, mask } of PII_PATTERNS) {
    sanitized = sanitized.replace(regex, mask);
  }
  return sanitized;
}

/**
 * Optimizes structured records before AI analysis by:
 * 1. Removing sensitive credentials completely (passwords, cards, CVV, OTPs)
 * 2. Masking PII fields
 * 3. Compressing long strings into compact structured fields to save AI tokens
 */
export function prepareAiPayload(data: Record<string, any>): MaskedPayload {
  const originalCharCount = JSON.stringify(data).length;

  const forbiddenKeys = [
    'password',
    'passwordEncrypted',
    'passwordHash',
    'netBankingUsername',
    'cards',
    'cvv',
    'pin',
    'secretKey',
    'apiKey',
    'loginUsername',
    'clientSecret',
    'token',
    'authCode',
    'secret',
    'privateKey',
    'passphrase',
  ];

  /**
   * Collapse a key to bare lowercase alphanumerics before matching.
   *
   * The list above is written in camelCase, but record keys are snake_case
   * taxonomy fieldKeys (`net_banking_username`, `login_username`). A plain
   * `includes` compares 'net_banking_username' against 'netbankingusername'
   * and finds nothing, so the two multi-word entries silently stopped
   * protecting anything the moment keys were normalised. Folding both sides
   * makes the list case- and separator-agnostic.
   */
  const fold = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
  const foldedForbidden = forbiddenKeys.map(fold);

  /**
   * Short entries match a whole WORD; long ones still match anywhere.
   *
   * Folding made the list separator-agnostic, which is what made the multi-word
   * entries work — and it also made the three-letter ones match inside unrelated
   * words. `'pin'` was silently eating `cin_or_llpin`, a company identifier
   * printed on every MoA and partnership deed, so that field never reached a
   * single AI payload and nothing said why.
   *
   * So a short entry must line up with a word boundary of the ORIGINAL key —
   * `upi_pin` and `pinCode` still match, `cin_or_llpin` no longer does. The long
   * entries keep substring matching, where a false positive is implausible and
   * the cost of missing one is a leaked credential.
   *
   * This NARROWS the filter, which is the dangerous direction. It is asserted
   * both ways in tests/aiPrivacyMasker.test.ts rather than trusted to review.
   */
  const SHORT = new Set(['pin', 'cvv', 'cards', 'token', 'secret']);
  const words = (key: string) => key
    // camelCase and snake_case alike → the words the author actually wrote.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const isForbidden = (key: string) => {
    const folded = fold(key);
    const keyWords = new Set(words(key));
    return foldedForbidden.some((f) => (SHORT.has(f) ? keyWords.has(f) : folded.includes(f)));
  };

  const cleanObject = (obj: any): any => {
    if (!obj || typeof obj !== 'object') {
      return typeof obj === 'string' ? maskSensitiveText(obj) : obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(cleanObject);
    }
    const sanitizedObj: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isForbidden(key)) {
        continue; // Drop credential keys entirely
      }
      // Compress verbose text fields longer than 300 characters
      if (typeof value === 'string' && value.length > 300) {
        sanitizedObj[key] = maskSensitiveText(value.slice(0, 300) + '... [truncated for token optimization]');
      } else {
        sanitizedObj[key] = cleanObject(value);
      }
    }
    return sanitizedObj;
  };

  const sanitizedData = cleanObject(data);
  const optimizedCharCount = JSON.stringify(sanitizedData).length;
  const reduction = Math.max(0, Math.round(((originalCharCount - optimizedCharCount) / Math.max(originalCharCount, 1)) * 100));

  return {
    sanitizedPrompt: JSON.stringify(sanitizedData),
    sanitizedData,
    tokenReductionPercentEstimate: reduction,
  };
}
