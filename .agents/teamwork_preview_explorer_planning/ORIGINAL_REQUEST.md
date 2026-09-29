## 2026-07-04T07:31:32Z
Analyze the codebase at d:\Apps\familyos\ to identify current implementations and requirements for the familyos overhaul project.
Specifically:
1. Search for all references to WhatsApp (models, routes, background workers, configuration, files) that must be removed for R1.
2. Inspect prisma/schema.prisma to understand existing models and plan how to add nullable `holderId` and `isGlobal` to all record models (R4). Also note WhatsApp-related models/fields to remove.
3. Analyze current tenant isolation checks in API routes and UI components. Identify how super admins are structured and where the checks are to block them from tenant-specific data pages and queries (R2).
4. Analyze the UI Shell (src/app/components/Shell.js or similar), main layout (src/app/layout.js), globals.css, and how page navigation is structured, to prepare for R3 (Vesta theme, collapsible sidebar, 5 categories).
5. Analyze the dashboard page, API settings, and billing/subscription logic to plan the Super Admin dashboard and Razorpay sandbox checkout (R7).
6. Check where file uploads and AI features are located to plan the follow-up, notifications, AI analysis, and "Auto-fill with AI" features (R5, R6).
7. Look at current backup/restore options or local storage setups to prepare for local storage options and JSON backup/restore (R8).

Write your findings to a file named `planning_report.md` in your working directory d:\Apps\familyos\.agents\teamwork_preview_explorer_planning\ and send a message back with the path to the report when done.
