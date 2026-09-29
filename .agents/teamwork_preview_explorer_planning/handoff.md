# Handoff Report — 2026-07-04T13:06:00+05:30

## 1. Observation
*   **WhatsApp References**:
    *   `scripts/whatsapp-worker.mjs`
    *   `src/app/api/whatsapp/route.js`
    *   `src/app/whatsapp/page.js`
    *   `src/lib/whatsapp-processor.js`
    *   `prisma/schema.prisma` contains `model WhatsappMessage` at line 292.
    *   `src/app/components/Shell.js` includes the navigation item `{ name: 'WhatsApp', path: '/whatsapp', icon: MessageSquareCode }` at line 206 and 384.
    *   `docker-compose.yml` includes the `familyos-worker` service at line 40: `command: node scripts/whatsapp-worker.mjs`.
*   **Database Schema**:
    *   All current record models (e.g., `Document`, `MedicalRecord`, `Password`, `BankInfo`, `TradingDemat`, `Vehicle`, `LicMediclaim`, `Investment`) in `prisma/schema.prisma` contain `userId` but do not contain `holderId` or `isGlobal`.
*   **Tenant Isolation**:
    *   `src/lib/auth.js` line 60-63:
        ```javascript
        if (user.role === 'SUPER_ADMIN') {
          const adminModules = ['tenants', 'ai-keys', 'audit_logs', 'whatsapp', 'dashboard'];
          return adminModules.includes(module);
        }
        ```
    *   `src/app/api/documents/route.js` line 16-19:
        ```javascript
        const allowed = await hasPermission(user, 'documents', 'view');
        if (!allowed) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        ```
*   **UI Shell and Theme**:
    *   `src/app/components/Shell.js` sets a fixed sidebar style of `w-[260px]`.
    *   `src/app/globals.css` base styles define `--primary: 217 91% 60%;` and other standard shadcn/tailwind HSL color variables.
*   **Dashboard & Billing**:
    *   `src/app/api/dashboard/route.js` returns system-wide activity logs for `SUPER_ADMIN` users (line 20-40) and counts total tenants, users, etc.
    *   `package.json` does not include dependencies for `nodemailer` or `razorpay`.

## 2. Logic Chain
1.  **WhatsApp Removal (R1)**: Since all references to WhatsApp must be deleted, files like `whatsapp-worker.mjs`, `whatsapp-processor.js`, the `/whatsapp` page directory, and the `/api/whatsapp` API route must be removed, and code references matching `WhatsappMessage` or `/whatsapp` route mapping in the sidebar shell and statistics dashboard must be deleted.
2.  **Schema Extensions (R4)**: To differentiate between global family records and user-held records, all 8 existing record tables must be altered to include a nullable `holderId` pointing to the `User` table, and an `isGlobal` boolean field. These tables must support visibility checks checking if a record is either owned by the user, held by the user, or marked global.
3.  **Super Admin Blocking (R2)**: Since `hasPermission` does not list standard modules under allowed `SUPER_ADMIN` modules, standard API endpoints already deny access with a 403 status. However, Super Admins can still manually navigate to standard record pages on the UI, which calls for adding client-side guards in `Shell.js` checking user roles and redirecting them away if a standard URL is requested.
4.  **Sidebar collapse & Categories (R3)**: To construct a collapsible sidebar and the cozy Vesta theme, `Shell.js` must implement a state toggle transitioning the width from `260px` to `72px` and hiding text items, while `globals.css` HSL color tokens are overwritten with Terracotta and Sand HSL equivalents.
5.  **Billing & Sandboxed Checkout (R7)**: The Super Admin dashboard must display tenant-wise AI Token usage (which calls for an `AiTokenUsage` tracker database model to log tokens used in `aiKeyManager.js` calls) and Razorpay sandbox checking (requiring the checkout script to simulate payments). The activity log query in `/api/dashboard` must be omitted.
6.  **Offline Setup (R8)**: To support local browser storage, the frontend client should inspect a `local_mode` value in browser storage. If active, it reads and writes records using browser IndexedDB rather than sending requests to backend routes. Exporting/restoring backups can be done by parsing and writing JSON dumps.

## 3. Caveats
*   We assume that the parent Modular SaaS (e.g. UdyamNX) SSO login redirects users through standard API requests containing token queries. If SSO configuration depends on tenant slug mappings, changing slugs to api keys requires updating the SSO module to match.

## 4. Conclusion
The overhaul plan is fully detailed in the `planning_report.md` file. It maps out precise changes to the schema, API endpoints, navigation categories, color styling variables, and offline setups.

## 5. Verification Method
*   Inspect `planning_report.md` directly.
*   Validate schema changes locally by running `npx prisma migrate dev --create-only` after updating the Prisma file to confirm syntax correctness.
