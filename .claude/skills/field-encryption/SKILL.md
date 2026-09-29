---
name: field-encryption
description: >-
  How docsnx encrypts sensitive database columns at rest and handles bearer
  secrets. Read BEFORE storing, reading, comparing, or migrating any sensitive
  field (passwords, card data, account numbers, usernames, reset tokens, OTPs,
  API keys). Covers encrypt/decrypt vs encryptField, blindIndex for lookups,
  hashToken for bearer secrets, idempotent backfills, and the never-expose rule.
  Triggers on: "encrypt", "decrypt", "encryptField", "blindIndex", "hashToken",
  "reset token", "OTP", "at rest", "sensitive column".
---

# Field-level encryption at rest (docsnx)

Helpers: `src/lib/encryption.ts` (AES-256-GCM primitives) and
`src/lib/fieldCrypto.ts` (field wrappers). This is SEPARATE from the browser-side
Zero-View encryption (`clientCrypto.ts`) — see `zero-trust-privacy`.

## Choose the right primitive

| Value type | Use | Why |
|---|---|---|
| Reversible secret you must display again (account #, username, card data, API key) | `encryptField(v)` → store; `decryptField(v)` → read | AES-256-GCM, `iv:salt:tag:ct` |
| A field you must also look up / de-dupe by exact value | store `encryptField(v)` **and** a companion `*_hash = blindIndex(v)` column (the existing convention — e.g. `account_number_hash`, `demat_account_number_hash`); query by the blind index | deterministic keyed HMAC, no plaintext exposed |
| Bearer secret never shown again (password-reset token, email OTP) | `hashToken(v)` → store; re-hash incoming value to compare | one-way; a DB leak can't reveal it |
| User login password | `hashPassword` / `comparePassword` (bcrypt, `src/lib/auth.ts`) | never encrypt passwords |

## Rules
- `encryptField`/`decryptField` are **null-safe**: null/undefined/empty → `null`
  (keeps nullable columns null instead of storing empty ciphertext).
- `encryptField` is **idempotent** — it passes already-ciphertext values through
  (`isCiphertext`), so backfills can re-run safely.
- Reset tokens & OTPs must be **hashed, not encrypted**. Do not `encrypt()` a
  value you only ever compare.
- `blindIndex` normalizes (trim, strip whitespace, uppercase) before HMAC, so
  `"1234 5678"` and `"12345678"` match. Use it for de-duplication too.
- Encrypt at the boundary: encrypt right before `insert/update`, decrypt right
  after the read — never store plaintext, never log plaintext or ciphertext keys.

## Never expose
- `passwordHash` must never leave the server (destructure it out; `auth.ts`
  already strips it in `getUserFromRequest`).
- Encrypted columns (`passwordEncrypted`, `cards`, etc.) must be stripped from
  list responses and only decrypted for an authorized single-record view.

## Backfill pattern (idempotent)
```ts
for (const row of rows) {
  if (isCiphertext(row.accountNumber)) continue;      // already migrated
  await tx.update(bankInfos)
    .set({ accountNumber: encryptField(row.accountNumber),
           accountNumberHash: blindIndex(row.accountNumber) })   // *_hash blind index
    .where(and(eq(bankInfos.id, row.id), eq(bankInfos.tenantId, row.tenantId)));
}
```
Adding a new encrypted column? Also add its `*_hash` companion if it needs lookup,
and use the `drizzle-migrator` agent for the schema/migration.
