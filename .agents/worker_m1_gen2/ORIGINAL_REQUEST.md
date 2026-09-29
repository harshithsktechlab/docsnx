## 2026-07-04T08:00:00Z
You are the Worker (Replacement Gen 2) for Milestone 1: WhatsApp Removal & Super Admin Guards.
Your working directory is d:\Apps\familyos\.agents\worker_m1_gen2.
Your mission is to perform all code updates and file deletions to implement Milestone 1.

Refer to the following Explorer handoff reports for details of the files and code locations:
- Explorer 1 (Backend/Schema): d:\Apps\familyos\.agents\explorer_m1_1\handoff.md
- Explorer 2 (Frontend UI): d:\Apps\familyos\.agents\explorer_m1_2\handoff.md
- Explorer 3 (Super Admin Guards): d:\Apps\familyos\.agents\explorer_m1_3\handoff.md

Tasks:
1. Delete the following files:
   - `scripts/whatsapp-worker.mjs`
   - `src/lib/whatsapp-processor.js`
   - `src/app/whatsapp/page.js`
   - `src/app/api/whatsapp/route.js`
2. Update `prisma/schema.prisma` to remove the `WhatsappMessage` model.
3. Update `prisma/seed.js` to remove `WhatsappMessage` seed logic.
4. Update `scripts/query-db.mjs` to remove `db.whatsappMessage` query.
5. Update `src/lib/ai.js` to remove the functions `parseWhatsAppMessage` and `buildMockWhatsAppParse`.
6. Update `src/lib/auth.js` to remove `'whatsapp'` from `adminModules`.
7. Update `src/app/components/Shell.js` to:
   - Remove imports/references to `MessageSquareCode`.
   - Remove sidebar navigation items and mobile links to `/whatsapp`.
   - Implement client-side route guard: if user role is `SUPER_ADMIN`, redirect them away from tenant-specific routes `/documents`, `/medical`, `/passwords`, `/bank-info`, `/trading`, `/vehicles`, `/lic-mediclaim`, `/investments`, `/profile`, `/users`, and `/dashboard/bulk-scan` to `/tenants` using `router.replace('/tenants')` reactively.
8. Update `src/app/dashboard/page.js` to remove the "WhatsApp Logs" stat card and the WhatsApp quick action button.
9. Update `src/app/api/dashboard/route.js` to remove `whatsappCount` query, counts, and response keys.
10. Update `src/app/more/page.js` to remove WhatsApp options.
11. Update `src/app/register/page.js` and `src/app/users/page.js` to remove WhatsApp labels/hints.
12. Update `docker-compose.yml` to remove the `familyos-worker` service and `STITCH_API_KEY` env var.
13. Update `.env` to remove `STITCH_API_KEY`.
14. Update references in documentation: `project-context/database.md`, `project-context/integrations.md`, `AI_CONTEXT.md`, and `AGENTS.md`.
15. Run `npx prisma generate` to update the client.
16. Run `npm run build` to verify the codebase compiles successfully.

MANDATORY INTEGRITY WARNING:
> DO NOT CHEAT. All implementations must be genuine. DO NOT
> hardcode test results, create dummy/facade implementations, or
> circumvent the intended task. A Forensic Auditor will independently
> verify your work. Integrity violations WILL be detected and your
> work WILL be rejected.

Write your final status report detailing what files were modified, what was deleted, and the build results to d:\Apps\familyos\.agents\worker_m1_gen2\handoff.md.
Send a message to parent when done.

## 2026-07-04T08:02:13Z
Received message from Parent: "The implementation task has already been completed by Worker 1. Please stop execution and exit."
