# BRIEFING — 2026-07-04T16:02:10+05:30

## Mission
Refactor record cards to show Share & Download as PDF face actions with all other actions in a three-dot dropdown menu, and integrate AI Autofill into file upload flows.

## 🔒 My Identity
- Archetype: preview_worker
- Roles: implementer, qa, specialist
- Working directory: d:\Apps\familyos\.agents\worker_m4_cards
- Original parent: c3816e33-ecf6-4d74-bfea-a81126a6bdb4
- Milestone: M4 Card & AI Refactoring

## 🔒 Key Constraints
- JavaScript only (no TypeScript)
- Tenant Isolation first
- Do not cheat
- Verify Web Share

## Current Parent
- Conversation ID: c3816e33-ecf6-4d74-bfea-a81126a6bdb4
- Updated: 2026-07-04T16:02:10+05:30

## Task Summary
- **What to build**: Card action button refactoring (Share + Download face, rest in dropdown) and Auto-fill with AI button in file uploads.
- **Success criteria**: Exactly two face buttons (Share, Download as PDF). Three-dot dropdown overlay with Edit, Delete, Preview actions. Auto-fill with AI calls /api/ai/scan to parse and fill form fields.
- **Interface contracts**: Next.js App Router, React 19, tailwind CSS, Lucide icons, navigator.share.
- **Code layout**: src/app/

## Key Decisions Made
- Simple local react state for card dropdowns to avoid prop drilling and keep it clean and robust.
- Reuse existing file scanning OCR APIs or inspect `src/app/todos/page.js` to see how "Auto-fill with AI" is implemented.

## Change Tracker
- **Files modified**:
  - `src/app/todos/page.js` — Refactor card actions to Share + Download PDF face, other actions to dropdown.
  - `src/app/documents/page.js` — Refactor card actions, add AI scan/autofill states/button/handlers.
  - `src/app/medical/page.js` — Refactor card actions, add AI scan/autofill states/button/handlers.
  - `src/app/vehicles/page.js` — Refactor card actions, add AI scan/autofill states/button/handlers.
  - `src/app/lic-mediclaim/page.js` — Refactor card actions, add AI scan/autofill states/button/handlers.
  - `src/app/rentals/page.js` — Refactor card actions.
  - `src/app/warranty/page.js` — Refactor card actions.
  - `src/app/passwords/page.js` — Refactor card actions.
  - `src/app/bank-info/page.js` — Refactor card actions.
  - `src/app/trading/page.js` — Refactor card actions.
  - `src/app/investments/page.js` — Refactor card actions, fix typo.
  - `src/app/emergency-contacts/page.js` — Refactor card actions.
- **Build status**: PASS
- **Pending issues**: None

## Quality Status
- **Build/test result**: PASS (compilation completes successfully)
- **Lint status**: 0 outstanding violations
- **Tests added/modified**: N/A (Verification via build + manual check)

## Artifact Index
- None.
