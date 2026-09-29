---
name: zero-trust-privacy-shield
description: Automatically enforces AI Privacy Shield (Zero-Credentials & PII masking), Zero-View Client-Side Encryption (PBKDF2 + AES-256-GCM), Modular Google Drive Sync (/DocsNX_Data/<module>.enc.json), and AI Token Reduction/Payload Compression across all 18 record modules in DocsNX without requiring manual user prompts.
---

# Zero-Trust AI Privacy Shield & Zero-View Encryption Standard

This automated project-level skill triggers whenever AI analysis, database record synchronization, Google Drive backup/restore, or sensitive document handling is modified or created in DocsNX.

---

## 1. AI Privacy Shield & Zero-Credentials Enforcement

Whenever data is sent to external LLM providers (Gemini or OpenAI) via `src/lib/ai.js`, **zero credentials** or raw PII may ever be transmitted.

### Mandatory Rules:
1. **Forbidden Credential Stripping**: Every record or category payload MUST pass through `prepareAiPayload(data)` from `src/lib/aiPrivacyMasker.ts` before serialization.
2. **Stripped Keys List**: Any key matching `password`, `passwordEncrypted`, `passwordHash`, `netBankingUsername`, `cards`, `cvv`, `pin`, `secretKey`, `apiKey`, `loginUsername`, `clientSecret`, `token`, `authCode`, `secret`, `privateKey`, or `passphrase` is dropped entirely.
3. **PII Masking**: Indian Aadhaar (`[AADHAAR-MASKED]`), PAN (`[PAN-MASKED]`), Bank Account Numbers (`[ACCOUNT-NUM-MASKED]`), Phone Numbers (`[PHONE-MASKED]`), and Emails (`[EMAIL-MASKED]`) must be masked using regex before transmission.

---

## 2. Payload Compression & AI Token Reduction

To optimize API costs and latency:
1. **String Truncation**: Free-text fields exceeding 300 characters inside structured records are automatically compressed (`value.slice(0, 300) + '... [truncated for token optimization]'`).
2. **Compact JSON Schemas**: All AI prompt templates (`generateCategoryAnalysis`, `generateRecordAnalysis`) enforce ultra-concise JSON response structures (10–15 words max per bullet point).
3. **Token Reduction Metric**: `prepareAiPayload(data)` returns an estimated `tokenReductionPercentEstimate` tracking prompt optimization gains.

---

## 3. Zero-View Client-Side Encryption (Web Crypto API)

All family records stored in Google Drive or exported for backup must use **Zero-View Client-Side Encryption** (`src/lib/clientCrypto.ts`):
1. **Key Derivation**: Derive `CryptoKey` in browser memory using `PBKDF2` (`100,000 iterations`, `SHA-256`) from the user's Master Passphrase and tenant salt.
2. **Cipher Engine**: Encrypt payloads using `AES-256-GCM` with a fresh 12-byte random Initialization Vector (`IV`).
3. **Ciphertext Format**: Always output formatted ciphertext strings: `ivHex:ciphertextHex`. Plaintext never leaves the browser.

---

## 4. Modular BYOD Google Drive Zero-Knowledge Sync Engine (`POST /api/sync/google-drive`)

When syncing family records to Google Drive (`src/lib/driveSync.ts` & `src/app/api/sync/google-drive/route.ts`):
1. **BYOD Exclusivity**: If `tenant.googleDriveEnabled` is true, data is exclusively synced to the tenant's personal Google Drive folder (`/DocsNX_Data`) so ownership remains 100% with the tenant.
2. **Granular Partitioning**: Store each of the 18 record modules as a separate encrypted JSON file under `/DocsNX_Data/<module>.enc.json`:
   - `manifest.enc.json`, `passwords.enc.json`, `medical.enc.json`, `lic_mediclaim.enc.json`, `bank_info.enc.json`, `investments.enc.json`, `documents.enc.json`
   - `trading_demats.enc.json`, `vehicles.enc.json`, `warranty_amcs.enc.json`, `contract_agreements.enc.json`, `emergency_contacts.enc.json`, `todos.enc.json`
   - `tax_compliance.enc.json`, `wills_estate.enc.json`, `loans_debt.enc.json`, `utility_bills.enc.json`, `corporate_compliance.enc.json`, `employment_payroll.enc.json`
3. **Quota Overflow Detection**: Catch HTTP 403/507 (`storageQuotaExceeded`) and return `{ status: 'QUOTA_EXCEEDED' }` to prompt modal fallback without crashing the UI.

---

## Automated Verification Checklist

Before finalizing any PR or feature implementation:
- [ ] Verify that `prepareAiPayload` is invoked on AI input payloads.
- [ ] Verify that new database tables are included in `src/lib/driveSync.ts` (`ModuleName` and `MODULE_FILE_NAMES`).
- [ ] Verify that full backup/restore endpoints (`/api/backup`) handle multi-tenant isolation (`tenantId`).
