## 2026-07-04T10:32:10Z
You are the teamwork_preview_worker.
Your working directory is d:\Apps\familyos\.agents\worker_m4_cards.
Your task is to refactor all record cards across all 12 modules, and integrate "Extract with AI" / "Auto-fill with AI" button into the file upload section of all forms.

Please follow these steps:
1. Identify all page components that display records in card grids:
   - `src/app/documents/page.js`
   - `src/app/medical/page.js`
   - `src/app/passwords/page.js`
   - `src/app/bank-info/page.js`
   - `src/app/trading/page.js`
   - `src/app/vehicles/page.js`
   - `src/app/lic-mediclaim/page.js`
   - `src/app/investments/page.js`
   - `src/app/todos/page.js`
   - `src/app/emergency-contacts/page.js`
   - `src/app/warranty/page.js`
   - `src/app/rentals/page.js`
2. For each card displayed on these pages:
   - Refactor the action buttons group. Currently it contains separate buttons for Share, Print/PDF, Download, Edit, Preview File, and Delete.
   - Change it so that the card face displays EXACTLY TWO prominent buttons:
     1. "Share" button: uses Lucide `Share2` icon, title "Share", calling `handleShare` or `shareRecord` (which uses `navigator.share` on supported devices).
     2. "Download as PDF" button: uses Lucide `FileDown` or `Printer` or `Download` icon, title "Download as PDF", calling `handlePrint` or `printRecord` (which prints/saves as PDF).
   - All other actions (Edit, Delete, and Preview File / View File if present) MUST be moved to a secondary dropdown menu.
   - Implement the dropdown menu using simple, clean React component state scoped per card (or tracking the active card's dropdown open state in the page component, e.g. `activeDropdownId`). When the user clicks the three-dot button (Lucide `MoreVertical`), it toggles the dropdown overlay. The dropdown should render absolutely positioned, overlapping or floating next to the three-dot menu, containing:
     - "Preview" / "View File" (if there is an attachment/filePath)
     - "Edit" (with Lucide `Pencil` or text)
     - "Delete" (with Lucide `Trash2` or text)
3. Ensure the "Extract with AI" / "Auto-fill with AI" button is integrated into the upload flow for every module.
   - Ensure that for any module that has a file upload input in its Add/Edit form (Documents, Medical, Vehicles, LIC & Mediclaim, To-Dos, Warranty & AMC, Rentals & Subscriptions), there is a button next to or below the file input saying "Auto-fill with AI" (with Lucide `Sparkles` icon).
   - Clicking this button should call `/api/ai/scan` to perform OCR on the selected file, extract structured data, and auto-populate all the corresponding form inputs (e.g. name, date, hospital, price, etc.) as we saw in the To-Dos module.
4. Verify Web Share `navigator.share` invocation works correctly.
5. Run `npm run build` to verify the code compiles without errors or linting issues.
6. Write a detailed `handoff.md` and report back.

MANDATORY INTEGRITY WARNING: DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
