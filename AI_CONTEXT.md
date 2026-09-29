# Project Context — docsnx

> **Manually reconciled + curated on 2026-07-23** to match the real stack
> (Drizzle ORM + TypeScript + Postgres RLS). The prior version was auto-generated
> when the project used Prisma and was badly out of date.
>
> The generator (`src/lib/context-manager.mjs`) has since been **ported to read
> `src/db/schema.ts` (Drizzle)**, so `npm run update-context` is safe to run again
> and produces accurate output. Note that regenerating **replaces this
> hand-curated version with a leaner auto-generated one** (raw table/column dump,
> no domain grouping or security narrative). Prefer editing this file by hand, or
> regenerate and re-curate.

## 1. Project Information
- **Name / version**: docsnx `0.1.0` (multi-tenant member-management SaaS vault).
- **Framework**: Next.js `15.1` (App Router, no `pages/`), React `19`, TypeScript `~6`.
- **Database ORM**: **Drizzle ORM `^0.45`** over PostgreSQL (`pg ^8`); migrations
  via **`drizzle-kit`** (`drizzle.config.ts`, generated SQL in `drizzle/`).
- **Deploy**: Oracle Cloud (OCI), Docker (`Dockerfile`, `docker-compose.yml`).
- **Key scripts**: `dev` (`next dev --turbo`), `build`, `start`, `lint` (`eslint`),
  `test` (`vitest run`), `test:coverage`, `update-context` (⚠️ stale, see above).

## 2. Architecture & Data Flow
Client → API Route (`src/app/api/**/route.ts`) → **AuthN** `getUserFromRequest(req)`
→ **AuthZ** `hasPermission(user, module, action)` → **validation** (`zod`) →
**tenant-scoped data access** `withTenant(user.tenantId, tx => …)` (Drizzle) →
**audit log** → response with secrets stripped.

- **Frontend**: `src/app/` pages; UI in `src/components/ui/` (Radix + Tailwind v3
  + CSS variables, glassmorphism dark mode, `framer-motion`). Client helpers in
  `src/hooks/`, `src/lib/clientAuth.ts`, `src/lib/clientCrypto.ts`.
- **Backend**: Next.js Route Handlers under `src/app/api/`.
- **Core libs** (`src/lib/`): `db.ts` (Drizzle client + `withTenant`), `auth.ts`
  (JWT + bcrypt + permissions), `encryption.ts` / `fieldCrypto.ts` (AES-256-GCM at
  rest, blind index, token hashing), `aiKeyManager.ts` (`executeWithRotation`),
  `ai.js` / `aiProfiles.ts`, `aiPrivacyMasker.ts` (`prepareAiPayload`),
  `driveSync.ts` / `googleDrive.ts` (Zero-Knowledge Drive sync), `storage.ts` /
  `azureBlob.ts` / `uploadAccess.ts` (file storage), `razorpay.js` (payments),
  `mailer.ts` (SMTP), `api-pagination.ts`, `rateLimit.ts`.

## 3. Authentication & Authorization
- **JWT** (`jsonwebtoken`) signed with `JWT_SECRET`, 7-day expiry, stored as an
  `HttpOnly` cookie named `auth_token`. Passwords hashed with **bcrypt**.
- **Roles** (`roleEnum`): `SUPER_ADMIN`, `TENANT_ADMIN`, `STANDARD`.
  `SUPER_ADMIN` is limited to platform modules (`tenants`, `ai-keys`,
  `audit_logs`, `dashboard`) and must **not** read tenant data. `TENANT_ADMIN`
  has full access within its tenant. `STANDARD` is gated by per-module
  `permissions` (`canView/Add/Edit/Delete/Share`).
- Expired subscription (`tenants.subscriptionExpiry` in the past) → access denied.

## 4. Tenant Isolation (critical)
Two layers, both mandatory:
1. **Postgres RLS** — `withTenant(tenantId, cb)` (`src/lib/db.ts`) opens a
   transaction and runs `set_config('app.tenant_id', tenantId, true)`; RLS
   policies filter rows to the current tenant.
2. **Explicit predicate** — every Drizzle `where` on a tenant table includes
   `eq(table.tenantId, user.tenantId)` and reads add `isNull(table.deletedAt)`.

`tenantId`/`userId` used for scoping always come from the authenticated `user`,
never from the request. `[id]` routes scope by id **and** tenantId (anti-IDOR).

## 5. Encryption & Privacy
- **At rest** (server): AES-256-GCM via `encrypt`/`encryptField` (format
  `iv:salt:tag:ct`). Deterministic lookups use `blindIndex` (keyed HMAC). Bearer
  secrets (reset tokens, OTPs) are **hashed** (`hashToken`), not encrypted.
  `passwordHash` is never sent to the client.
- **Zero-View** (browser): `clientCrypto.ts` — PBKDF2 (100k, SHA-256) + AES-256-GCM
  encrypts records before any cloud/Drive write; plaintext never leaves the client.
- **AI Privacy Shield**: every AI payload passes through `prepareAiPayload`
  (`aiPrivacyMasker.ts`) — strips credential keys, masks PAN/Aadhaar/account/
  phone/email, compresses long strings. All model calls go through
  `executeWithRotation` (`aiKeyManager.ts`); default provider Gemini
  (`gemini-2.5-flash`), OpenAI supported. See AGENTS.md §11 for the full standard.

## 6. Database Schema (`src/db/schema.ts`) — 39 tables, 1 enum
UUID PKs (`uuid().primaryKey().defaultRandom()`), `createdAt`/`updatedAt` on all,
nullable `deletedAt` for soft delete on tenant tables.

- **Tenancy & auth**: `tenants`, `users`, `permissions`, `profiles`,
  `user_devices`, `trial_used_emails`.
- **Record vault (tenant user data)**: `documents`, `medical_records`,
  `passwords`, `bank_infos`, `credit_cards`, `trading_demats`, `vehicles`,
  `lic_mediclaims`, `investments`, `emergency_contacts`, `warranty_amcs`,
  `contract_agreements`, `todos`, `tax_compliances`, `wills_estates`,
  `loans_debts`, `utility_bills`, `corporate_compliances`, `employment_payrolls`.
- **AI**: `ai_api_keys`, `api_keys`, `tenant_ai_usages`, `ai_analysis_cache`,
  `system_configs`.
- **Billing**: `subscription_plans`, `addons`, `tenant_addons`, `payments`,
  `invoices`, `discount_codes`, `discount_usages`.
- **Ops**: `audit_logs`, `notifications`.

Sensitive columns storing ciphertext/hashes include: `passwords.password_encrypted`,
`credit_cards`/`bank_infos.cards`, `bank_infos.net_banking_username` &
`account_number`, `trading_demats.login_username`, `tenants.api_key`,
`ai_api_keys`, and `users.reset_token` / `email_verification_otp` (hashed).

## 7. Integrations
- **AI**: Gemini (`@google/genai`) + OpenAI (`openai`), via `aiKeyManager`.
- **Storage**: Azure Blob (`@azure/storage-blob`), Firebase (`firebase`/-admin),
  Google Drive (`googleapis`) for Zero-Knowledge sync.
- **Payments**: Razorpay (`razorpay`), webhooks at `src/app/api/webhooks/razorpay`.
- **Email**: SMTP via `nodemailer` (`mailer.ts`); config in `system_configs`.
- **Docs/PDF**: `jspdf`, `pdfkit`, `mammoth`, `word-extractor`, `xlsx`.

## 8. Testing & Quality
- **Unit/integration**: Vitest (`vitest.config.ts`, `vitest.setup.ts`, `tests/`),
  `@testing-library/react`, jsdom. Run: `npm test` / `npx vitest run <file>`.
- **E2E**: Playwright (`playwright.config.ts`, `e2e/`) + `@axe-core/playwright`.
- **Lint**: ESLint flat config (`eslint.config.mjs`) + `eslint-plugin-tailwindcss`.
- **Claude Code config**: see `.claude/README.md` (agents, skills, commands, hooks).
