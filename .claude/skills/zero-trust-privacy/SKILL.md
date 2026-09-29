---
name: zero-trust-privacy
description: >-
  The mandatory Zero-Trust AI Privacy Shield & Zero-View Encryption standard for
  docsnx (AGENTS.md §11). Read BEFORE writing or modifying any record-vault
  module, AI analysis helper, prompt builder, or Google Drive sync code — i.e.
  anything that sends structured records to Gemini/OpenAI or stores records
  outside Postgres. Covers the 4 pillars: AI payload masking, payload
  compression, client-side Zero-View encryption, and modular ZK Drive sync.
  Triggers on: "AI", "Gemini", "OpenAI", "prompt", "prepareAiPayload", "analysis",
  "drive sync", "clientCrypto", "encrypt before upload".
---

# Zero-Trust AI Privacy Shield & Zero-View Encryption

Automatically enforce all 4 pillars — no manual prompt required — whenever you
create/modify a vault module, AI helper, or sync script.

## Pillar 1 — AI Privacy Shield & Zero-Credentials
Any structured data sent to an AI model MUST first pass through
`prepareAiPayload(data)` in `src/lib/aiPrivacyMasker.ts`.

```ts
import { prepareAiPayload } from '@/lib/aiPrivacyMasker';
const { sanitizedPrompt, sanitizedData, tokenReductionPercentEstimate } = prepareAiPayload(record);
// send sanitizedPrompt / sanitizedData to the model — NEVER the raw record
```
It drops forbidden credential keys entirely (`password`, `passwordEncrypted`,
`passwordHash`, `cards`, `cvv`, `pin`, `netBankingUsername`, `loginUsername`,
`clientSecret`, `token`, `authCode`, `secret`, `privateKey`, `passphrase`,
`apiKey`, `secretKey`) and regex-masks PII (PAN, Aadhaar, account numbers,
phone, email). If you introduce a new sensitive key, ADD it to `forbiddenKeys`
there and cover it with a test.

**All model calls go through `executeWithRotation()` (`src/lib/aiKeyManager.ts`).**
Never import the Gemini/OpenAI SDK and call it directly — that bypasses key
rotation, quota, and the shield.

## Pillar 2 — Payload compression / token reduction
Free-text strings > 300 chars inside a record must be compressed/truncated
before serialization (this is what `prepareAiPayload` already does for long
strings). When you build custom prompts, don't re-expand full documents — send
the masked, compressed `sanitizedData`, and summarize large blobs first.

## Pillar 3 — Zero-View client-side encryption
Records synced to the cloud/Drive are encrypted **in the browser** so plaintext
never leaves the client. Use `src/lib/clientCrypto.ts` (Web Crypto API):
PBKDF2 (100k iterations, SHA-256) → AES-256-GCM, output `ivHex:ciphertextHex`.
Do NOT roll your own crypto and do NOT encrypt Zero-View data server-side.
(Server-side at-rest encryption of DB columns is a *separate* concern — see the
`field-encryption` skill.)

## Pillar 4 — Modular Google Drive Zero-Knowledge sync
Each of the record modules is partitioned into its own encrypted file on the
tenant's Drive: `/DocsNX_Data/<module>.enc.json` via `src/lib/driveSync.ts`.
- One file per module (never a single combined dump).
- Files contain only Pillar-3 ciphertext.
- Handle quota-overflow detection; fail closed (don't write partial/plaintext).

## Definition of done
- [ ] Every AI payload goes through `prepareAiPayload`.
- [ ] Every model call goes through `executeWithRotation`.
- [ ] New credential-ish keys added to `forbiddenKeys` + tested.
- [ ] Cloud/Drive records encrypted client-side (`clientCrypto`) before leaving.
- [ ] Drive writes are per-module `.enc.json`, ciphertext only.

Verify with the `security-auditor` agent whenever you touch this surface.
