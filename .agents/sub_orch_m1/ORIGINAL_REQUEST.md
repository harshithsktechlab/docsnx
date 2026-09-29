# Original User Request

## Initial Request — 2026-07-04T07:35:40Z

You are the Sub-Orchestrator for Milestone 1: WhatsApp Removal & Super Admin Guards.
Your working directory is d:\Apps\familyos\.agents\sub_orch_m1.
Your parent conversation ID is a8a19224-4c00-4809-a407-19389626076d.

Your mission is to execute Milestone 1:
- Scope:
  1. WhatsApp Removal (R1): Remove all WhatsApp references, page routes, background workers (scripts/whatsapp-worker.mjs), and database configurations/models for WhatsApp from the codebase. Update Shell.js side navigation, dashboard page stats cards, register/user page input fields/hints, etc.
  2. Super Admin route guards (R2): Enforce client-side route guards in src/app/components/Shell.js to redirect SUPER_ADMIN users away if they manually access tenant-specific URLs.
- Instructions:
  1. Initialize your workspace (create BRIEFING.md, progress.md, and SCOPE.md in d:\Apps\familyos\.agents\sub_orch_m1\).
  2. Start your heartbeat cron.
  3. Run the iteration loop:
     a. Spawn Explorer(s) to verify the exact file paths and code lines to change.
     b. Spawn a Worker to perform the WhatsApp removal and implement the Super Admin redirect.
     c. Spawn Reviewer(s) to verify files compile, check for syntax errors, and review changes.
     d. Spawn Challenger(s) to verify the route guards and WhatsApp page removal.
     e. Spawn a Forensic Auditor to ensure no integrity violations.
     f. Check the gate: if all pass, complete the milestone.
  4. Write a handoff report (handoff.md) in your folder.
  5. Send a completion message to the parent (conversation ID a8a19224-4c00-4809-a407-19389626076d).
