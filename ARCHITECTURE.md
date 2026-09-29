# DocsNX — Finalized Architecture (context digest)

> Dense reference for AI sessions. Source of truth = code; this mirrors it as of 2026-07-23.
> NOTE: `AI_CONTEXT.md` is auto-generated & STALE (says Prisma) — ignore it, use this.

## Stack
Multi-tenant records-vault SaaS (Oracle Cloud OCI). Next.js 15.1 App Router · React 19 · TS (strict) ·
Drizzle ORM 0.45 + PostgreSQL (`pg` pool) · Tailwind v3 + Radix + glassmorphism dark · Zod validation.
AI: Gemini (`gemini-2.5-flash`) default + OpenAI, via key-rotation pool. Payments: Razorpay. Files: Google Drive → Azure Blob → local FS. Auth: bcrypt + JWT httpOnly cookie. PWA via serwist. Push via Firebase FCM.

## Layout (`src/`)
- `app/` pages (route = folder). `app/api/**/route.ts` = 106 Route Handlers (`GET/POST/PUT/DELETE`).
- `db/schema.ts` (single Drizzle schema, ~40 tables) · `db/index.ts`.
- `lib/` shared utils (see Security). `components/` · `hooks/` · `scripts/`.
- `middleware.ts` rewrites `/uploads/*` → `/api/uploads/*` (forces auth on static files).
- `drizzle/` migrations incl. `0003_enable_rls.sql`, `0005_rls_policies.sql`.

## Canonical API route flow (all protected routes follow this)
```
getUserFromRequest(req)            // 401 if null; loads user + permissions + tenant, strips passwordHash
→ hasPermission(user, module, act) // 403 if false; act ∈ view|add|edit|delete|share
→ zod.parse(body)                  // validate input
→ withTenant(user.tenantId, tx =>  // opens txn, SET app.tenant_id → Postgres RLS enforces isolation
     encryptField/blindIndex on sensitive cols → tx insert/update/select)
→ decryptField + mask for list responses (full plaintext only on single-record [id] GET)
→ db.insert(auditLogs)             // after every mutation
→ NextResponse.json(...)
```

## Security (the core; enforce automatically — AGENTS.md §6/§11)

### 1. Tenant isolation (defense in depth)
- Every tenant-scoped table has `tenantId` FK (cascade). App-layer: filter by `user.tenantId`.
- `withTenant(tenantId, cb)` [lib/db.ts]: runs cb in a txn after `SELECT set_config('app.tenant_id', tenantId, true)`.
- DB-layer: Postgres RLS `tenant_isolation` policy `USING (tenant_id = current_setting('app.tenant_id',true)::uuid)` on all tenant tables. Missing the config var ⇒ rows invisible.
- **Rule: never query a tenant table without `withTenant` + tenantId filter.**

### 2. AuthN / AuthZ  [lib/auth.ts]
- JWT `{userId,email,role,tenantId}`, `JWT_SECRET`, 7d expiry, `auth_token` HttpOnly cookie.
- `getUserFromRequest` → decode → load user(+permissions,+tenant) → drop `passwordHash` → add `isExpired` (subscriptionExpiry past).
- `hasPermission(user, module, action)`: SUPER_ADMIN→only [tenants, ai-keys, audit_logs, dashboard]; TENANT_ADMIN→all; STANDARD→per-`permissions` row (canView/Add/Edit/Delete/Share). Expired tenant ⇒ false.
- Passwords: bcrypt(10). Reset tokens / email OTPs: store HMAC via `hashToken`, never plaintext.
- Rate limit [lib/rateLimit.ts]: in-memory; auth = 10 req / 15 min.

### 3. Encryption at rest  [lib/encryption.ts + lib/fieldCrypto.ts]
- Primitive: AES-256-GCM, `scryptSync(ENCRYPTION_SECRET, salt)`. **Server format = `iv:salt:tag:ct`** (4 hex groups); legacy 3-group `iv:tag:ct` still decodes.
- `encryptField/decryptField`: null-safe, idempotent (`isCiphertext` guard) — use these on columns.
- `blindIndex(v)`: deterministic HMAC-SHA256 (key = `BLIND_INDEX_KEY` or HKDF of ENCRYPTION_SECRET), normalized (trim/despace/upper) → stored in `*_hash` cols for exact-match lookup/dedup on encrypted fields.
- `hashToken`: one-way HMAC for bearer secrets (reset tokens, OTPs).
- Encrypted-at-rest columns: `passwords.passwordEncrypted`, `bank_infos.{accountNumber,customerId,netBankingUsername}`(+`accountNumberHash`), `credit_cards.cardDetailsEncrypted`, `trading_demats.{clientId,dematAccountNumber,loginUsername}`(+hashes), `lic_mediclaims.policyNumber`(+hash), `loans_debts.accountNumber`(+hash), `utility_bills.consumerNumber`(+hash), `tax_compliances.acknowledgementNumber`, `corporate_compliances.registrationNumber`, `contract_agreements.accountNumber`, `tenants.{apiKey,googleDriveTokens}` (via googleDrive.ts serialize/parse), DB-stored AI `apiKeys.apiKey`.

### 4. Display masking  [lib/dataMasking.ts]
List/collection endpoints decrypt then MASK (`maskTail/maskCard/maskCvv/maskUsername/maskEmail/maskPhone/maskDocId`, `maskFields(obj,map)`). Full plaintext only from permission-gated single-record `[id]` GET. CVV never returned.

### 5. AI Privacy Shield & token optimizer  [lib/aiPrivacyMasker.ts]
`prepareAiPayload(data)` before ANY AI serialization:
- Drops forbidden keys (substring-match): password, passwordEncrypted, passwordHash, netBankingUsername, cards, cvv, pin, secretKey, apiKey, loginUsername, clientSecret, token, authCode, secret, privateKey, passphrase.
- Regex-masks PII: Aadhaar, PAN, account# (9–18 digits), email, phone (+91/10-digit).
- Compresses free-text strings >300 chars. Returns `{sanitizedPrompt, sanitizedData, tokenReductionPercentEstimate}`.

### 6. AI key rotation  [lib/aiKeyManager.ts] — never call LLM SDKs directly
- `executeWithRotation(callFn)`: pool = active DB `apiKeys` (order priority→dailyUsage→errorCount, daily reset) + env `GEMINI_API_KEY` fallback. Classifies errors, rotates on QUOTA/RATE/OVERLOAD/INVALID, tracks usage/errors per key.
- `executeTenantWithRotation(tenantId, action, callFn)`: tenant's own `apiKey`→free (no credits); else check `aiCreditsBalance` ≥ cost (cost from systemConfigs × member multiplier), run pool, deduct credits, log `tenantAiUsages`. Actions: RECORD_ANALYSIS / CATEGORY_ANALYSIS / PORTFOLIO_ANALYSIS / BULK_SCAN.
- Keys decrypted via `decryptField` before building `GoogleGenAI`/`OpenAI` client. (`lib/ai.js` = higher-level helpers.)

### 7. Zero-View client-side encryption  [lib/clientCrypto.ts] (browser only)
Web Crypto: PBKDF2 (100k iter, SHA-256) → AES-256-GCM. **Client format = `ivHex:ciphertextHex`** (2 groups — distinct from server 4-group format). `deriveZeroKnowledgeKey(passphrase, saltHex)`, `encrypt/decryptZeroKnowledge`, `encryptFileBlobZeroKnowledge`. Plaintext + passphrase never leave browser.

### 8. Zero-Knowledge Google Drive sync  [lib/driveSync.ts, lib/googleDrive.ts, api/sync/google-drive]
19 record modules → one encrypted file each **inside a dedicated `DocsNX_Data` folder** on the tenant's Drive, at `/DocsNX_Data/<module>.enc.json`. Tenant-admin only (the Drive and its quota are the admin's), `POST` to sync and `GET` to read the ciphertext back for a client-side restore.

- **Module names are the `data` keys of `/api/backup`** — `MODULE_NAMES` in driveSync.ts — so a sync round-trips through the existing restore endpoint. They are camelCase (documents, medicalRecords, passwords, bankInfos, tradingDemats, vehicles, licMediclaims, investments, emergencyContacts, warrantyAmcs, contractAgreements, todos, taxCompliances, willsEstates, loansDebts, utilityBills, corporateCompliances, employmentPayrolls, users, +manifest). A caller-supplied key that is not on this list is rejected before it can become a filename.
- **`ensureDriveFolder`** resolves the folder: cached `tenants.googleDriveFolderId` (verified, since the user can trash it) → search → create. Under the `drive.file` scope the app only ever sees files it created, so a folder the user made by hand is invisible and a second one is created.
- **No duplicates.** `tenants.googleDriveFileIds` maps module → Drive file id; writes `update` in place. Omitting the id would create a second same-named file on every sync — Drive permits that. `adoptLegacyRootFiles` re-parents pre-folder `DocsNX_Data_*.enc.json` files out of My Drive root (moves + renames, never deletes).
- **Errors are classified structurally**, not by message: `isQuotaError` (`storageQuotaExceeded` / 507) → `QUOTA_EXCEEDED`; `isRevokedGrantError` (narrowly `invalid_grant`, *not* a bare 401) → `handleDriveAuthFailure` clears the grant so the plan quota applies again.
- **Refreshed tokens are persisted** via `oauth2Client.on('tokens')` in `getTenantDriveClient`, merged not replaced (Google omits `refresh_token` on refresh).

### 9. File uploads  [lib/upload.ts, storage.ts, uploadAccess.ts, googleDrive.ts, azureBlob.ts]
Router: tenant Google Drive (if enabled) → Azure Blob (if conn string) → local `public/uploads`. `checkStorageLimit` (plan GB + addons; Drive = unlimited — pass `{ ignoreDriveBypass: true }` for the underlying plan quota). Serving gated by `tenantOwnsUploadedFile(tenantId, filename)` — a record in caller's tenant must reference the `file_path`. `fileSize` summed per tenant for quota.

### 10. Google integration control  [app/settings, api/tenants/integrations/google, api/auth/google]
Tenant-admin only. `tenants.googleDriveEnabled` = on/off; `tenants.googleDriveTokens` = the stored grant; `googleDriveFolderId` / `googleDriveFileIds` / `googleAccountEmail` = where the data lives and which account consented.
- **Connect**: `/api/auth/google?returnTo=<allow-listed path>` → consent → `/api/auth/google/callback`. The callback identifies the admin from the **signed `state`** (10-min JWT `{tenantId,userId,returnTo,typ}`), *not* the session cookie — `auth_token` is `SameSite=Strict`, so the browser withholds it on the cross-site redirect back from Google. Role re-checked against the DB; audited as `GOOGLE_DRIVE_CONNECTED`.
- **`typ: 'google_oauth_state'` is mandatory** on that JWT. The session token is signed with the same `JWT_SECRET` and already carries `userId`+`tenantId`, so without the claim a 7-day session cookie is a valid `state` — silently replacing the 10-minute window with a week. Both routes are redirect flows: every exit is a redirect carrying `?google=<status>`, never JSON.
- **Scopes**: `drive.file` (only files this app created) + `userinfo.email` (records which account is linked).
- **Pause / resume**: `PATCH /api/tenants/integrations/google {enabled}` — keeps the tokens, so resuming needs no re-consent. 409 `NOT_CONNECTED` if there is no grant. Audited.
- **Disconnect**: `DELETE` — best-effort `revokeToken` at Google, then nulls the tokens regardless, so a network failure can't strand a tenant. Audited with `revokedAtGoogle`.
- Turning it off restores plan-quota enforcement; files already on Drive stay there. `GET` returns `planStorage` so the UI can warn with real numbers before a disable.

## Data model (Drizzle, `db/schema.ts`)
- IDs = `uuid defaultRandom`. Audit cols `createdAt/updatedAt` everywhere; `deletedAt` (soft delete) on record vaults. `roleEnum` = SUPER_ADMIN | TENANT_ADMIN | STANDARD.
- Core: `tenants` (aiProvider/aiModel/apiKey/aiCreditsBalance/googleDrive*/subscription/amc/maxMembers), `users` (passwordHash, role, consent*, reset/otp, requiresPasswordChange), `permissions` (per user×module bools, unique idx), `profiles` (jsonb personal/education/shopping/legal), `auditLogs`, `notifications`, `userDevices` (FCM), `emergencyContacts`, `todos`.
- Record vaults (tenant+user+`holderId`+`isGlobal`, `customFields` jsonb, `aiAnalysis` jsonb, `filePath/fileSize`): documents, medicalRecords, passwords, bankInfos, creditCards, tradingDemats, vehicles, licMediclaims, investments, warrantyAmcs, contractAgreements, taxCompliances, willsEstates, loansDebts, utilityBills, corporateCompliances, employmentPayrolls.
- Billing/AI: subscriptionPlans, addons, tenantAddons, payments (razorpay*), invoices (GST), discountCodes, discountUsages, apiKeys, aiApiKeys, systemConfigs (SMTP + AI costs), tenantAiUsages, aiAnalysisCache, trialUsedEmails.

## Module registry  [lib/moduleRegistry.js] — single source of truth for modules
`NAV_MODULES` (grouped) → derives `TENANT_SPECIFIC_PATHS`, `PERMISSION_MODULE_KEYS`, `DEFAULT_USER_PERMISSIONS`. `key` = the `module` string in `hasPermission`. Add module: edit `NAV_MODULES` + Shell.js icon map + driveSync.ts + `drizzle-kit push`. Don't hardcode module lists elsewhere.

## Env vars (names only)
DATABASE_URL, JWT_SECRET, ENCRYPTION_SECRET, (opt BLIND_INDEX_KEY), GEMINI_API_KEY,
GOOGLE_CLIENT_ID/SECRET, AZURE_STORAGE_CONNECTION_STRING/CONTAINER_NAME, FIREBASE_SERVICE_ACCOUNT,
RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET, NOTIFICATION_SERVICE_URL/API_KEY, APP_URL, NEXT_PUBLIC_APP_URL, PORT, UPLOAD_DIR, (opt DB_MAX_CONNECTIONS).
NEXT_PUBLIC_FIREBASE_API_KEY/AUTH_DOMAIN/PROJECT_ID/STORAGE_BUCKET/MESSAGING_SENDER_ID/APP_ID.

The six `NEXT_PUBLIC_FIREBASE_*` vars are **required at build time** — Next inlines
`NEXT_PUBLIC_*` into the client bundle during `next build` and never reads them at runtime,
so setting them in the systemd unit does nothing. A build without them ships
`projectId: undefined` and push notifications fail silently in every browser.
`next.config.mjs` fails the production build if any is missing. They must name the same
Firebase project as the server-side `FIREBASE_SERVICE_ACCOUNT` and as the hardcoded config in
[src/sw.ts]; the VAPID key in [lib/usePushNotifications.ts] is project-scoped too.

`UPLOAD_DIR` is the on-disk root for uploaded files (`/var/lib/docsnx/uploads` in prod, set in
the systemd unit alongside a matching `ReadWritePaths=`). It must stay **outside** `public/`:
files under `public/` get globbed into the service-worker precache manifest and would also be
served statically, bypassing the tenant check in `/api/uploads/[filename]`. The DB still stores
paths as `/uploads/<name>`; `next.config.mjs` rewrites those to the authenticated handler.

`APP_URL` is the deployment's public origin (`https://www.docsnx.com` in prod, set in
`/etc/systemd/system/docsnx.service` — not in the repo). Anything a user opens outside the
browser (password-reset links, OAuth redirects) must build its URL with `getAppBaseUrl()`
from [lib/appUrl.ts]; never from `PORT`, which yields an unusable `http://localhost:3005`.

## Invariants (do / never)
- ✔ `withTenant` + tenantId filter on every tenant table. ✖ never skip tenantId.
- ✔ encrypt sensitive cols via `encryptField` (+`blindIndex` for lookup) before insert. ✖ never store plaintext secrets; never send `passwordHash`/raw plaintext secrets to client (mask in lists).
- ✔ `prepareAiPayload` before any AI call; call LLMs only through `executeWithRotation`/`executeTenantWithRotation`. ✖ never call Gemini/OpenAI SDK directly.
- ✔ write `auditLogs` after every create/update/delete. ✔ validate input with Zod. ✔ TS strict for new code.
- ✖ never `drizzle-kit`/prisma reset in prod. Dev: `npm run dev`; DB: `npx drizzle-kit push` (dev) / `migrate` (prod); `docker compose up -d`.

## Dev commands
`npm run dev` · `npm run build` · `npm test` (vitest) · `npm run test:coverage` · e2e Playwright (`e2e/`, `playwright/`) · `npm run update-context`.
