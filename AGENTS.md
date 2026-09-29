# AGENTS.md

## 1. Project Overview
docsnx is a multi-tenant member management SaaS platform deployed on Oracle Cloud OCI. The platform provides a secure environment for households and businesses to manage sensitive information, including document vaults, medical records, encrypted password managers, and financial tracking. It features an AI assistant powered by Gemini and OpenAI. The stack uses Next.js 15.1 (App Router), React 19, TypeScript, Drizzle ORM, PostgreSQL, and Tailwind CSS v3.

## 2. Mandatory Startup Protocol
Before making changes to the codebase, AI agents must:
1. Read `AGENTS.md` and `AI_CONTEXT.md` to understand architectural boundaries and context.
2. Review `src/db/schema.ts` to understand tenant-scoped data models.
3. Understand the tenant isolation rules (every DB query MUST filter by `tenantId`).
4. Read the target API route or page component entirely.

## 3. Architecture at a Glance
- **Frontend (Next.js App Router)**: `src/app/` (no `pages/` directory). 
- **Backend (API Routes)**: `src/app/api/` (Next.js Route Handlers).
- **Core Libraries**: `src/lib/` contains essential shared utilities (`db.ts`, `auth.ts`, `encryption.ts`/`fieldCrypto.ts`, `aiKeyManager.ts`, `ai.js`).
- **Data Flow**: Client `->` API Route (`route.ts`) `->` Authentication (`getUserFromRequest`) `->` Authorization (`hasPermission`) `->` Data Access (`Drizzle ORM`).

## 4. Development Workflow
- **Local Dev**: Run `npm run dev`. Environment variables are required in `.env.local`.
- **Database**: Run `npx drizzle-kit push` locally (or migrate as needed). Use `npx drizzle-kit migrate` for production.
- **Docker**: Build and run locally via `docker compose up -d` to simulate OCI production environment.

## 5. Coding Standards
- **TypeScript Standard**: Use TypeScript (`.ts`/`.tsx`) for all new code. Use strict typing for database schema and payloads.
- **API Routes**: Export named functions (`GET`, `POST`, `PUT`, `DELETE`).
- **Authorization**: Call `hasPermission(user, module, action)` before data access in all protected routes.
- **Drizzle usage**: Use Drizzle ORM exclusively for database interactions. Use `withTenant` wrapper for tenant isolation.
- **Styling**: Use Tailwind CSS v3 + Radix UI + CSS variables (glassmorphism dark mode). Do not add other CSS frameworks.

## 6. Security Rules
- **Authentication**: JWT token signed with `JWT_SECRET`, 7-day expiry, stored as `HttpOnly` cookie.
- **Tenant Isolation**: Run every tenant-scoped query inside `withTenant(user.tenantId, async (tx) => …)` (which sets the Postgres RLS `app.tenant_id` session var) AND include an explicit `eq(table.tenantId, user.tenantId)` predicate in the Drizzle `where`. Never scope by a `tenantId` taken from the request body/query/params.
- **Encryption**: Sensitive fields (`passwordEncrypted`, `cards`, `netBankingUsername`) MUST be encrypted via `src/lib/encryption.ts` (or the field helpers in `src/lib/fieldCrypto.ts`) before DB insertion. Bearer secrets (reset tokens, OTPs) are hashed with `hashToken`, never reversibly encrypted.
- **Never expose passwords**: `passwordHash` must never be sent to the client.

## 7. Database Rules
- **ORM**: Drizzle ORM. Schema at `src/db/schema.ts`.
- **Primary Keys**: UUID columns — `uuid("id").primaryKey().defaultRandom()`.
- **Audit Columns**: `createdAt` and `updatedAt` are mandatory for all models; tenant-scoped tables also carry a nullable `deletedAt` for soft deletes (reads filter `isNull(table.deletedAt)`).
- **Audit Logging**: Insert into the `auditLogs` table (`audit_logs`) after any mutation (create/update/delete).

## 8. Key Integrations
- **Gemini / OpenAI**: Always use `executeWithRotation()` from `src/lib/aiKeyManager.ts` to call AI models. Never call APIs directly.

## 9. Forbidden Actions
- NEVER skip the `tenantId` check in queries. Use `withTenant` for all tenant-scoped queries.
- NEVER send unencrypted passwords or raw `passwordHash` to the client.
- NEVER call LLM APIs directly bypassing the `aiKeyManager`.
- NEVER run destructive DB commands in production (`drizzle-kit drop`, `DROP DATABASE`, `TRUNCATE`, or a `drizzle-kit push` that drops columns). Use forward-only `drizzle-kit migrate`.

## 10. Output Format
For any task, produce the following structure:
1. **Findings** - Relevant code blocks and paths
2. **Plan** - Step-by-step implementation plan
3. **Risks** - Potential issues (security, isolation)
4. **Implementation** - Explicit code paths
5. **Validation** - Verification instructions

## 11. Zero-Trust AI Privacy Shield & Zero-View Encryption Architecture (Mandatory Automated Standard)
When creating or modifying record vault modules, APIs, AI analysis helpers, or synchronization scripts, AI agents must automatically enforce the following 4 pillars without requiring manual user prompts:
1. **AI Privacy Shield & Zero-Credentials**: Pass all AI structured payloads through `prepareAiPayload(data)` (`src/lib/aiPrivacyMasker.ts`) to strip forbidden credential keys (`password`, `passwordEncrypted`, `cards`, `cvv`, `netBankingUsername`, `loginUsername`, `clientSecret`, `token`, `authCode`, `secret`, `privateKey`, `passphrase`) and regex-mask PII (PAN, Aadhaar, Account Numbers, Phone Numbers, Emails).
2. **Payload Compression & Token Reduction**: Free-text strings >300 characters inside structured records must be compressed before AI serialization to reduce token overhead.
3. **Zero-View Client-Side Encryption**: Use Web Crypto API (`src/lib/clientCrypto.ts`) with `PBKDF2` (100,000 iterations + SHA-256) and `AES-256-GCM` to encrypt records before cloud/Drive storage (`ivHex:ciphertextHex`). Plaintext never leaves browser memory.
4. **Modular Google Drive Zero-Knowledge Sync**: Partition all 18 record modules into dedicated encrypted files on the tenant's Google Drive (`/DocsNX_Data/<module>.enc.json` in `src/lib/driveSync.ts`) with quota overflow detection.
