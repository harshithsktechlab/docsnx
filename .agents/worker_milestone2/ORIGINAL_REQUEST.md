## 2026-07-04T08:41:01Z

Objective: Create the React page components for `/todos`, `/emergency-contacts`, `/warranty`, and `/rentals` matching the cozy Vesta layout and styling of other modules, and update the sidebar navigation in `Shell.js`.

Directory: d:\Apps\familyos
Your Working Directory: d:\Apps\familyos\.agents\worker_milestone2
Your Identity: worker (UI Developer)

Requirements:
1. JavaScript Only: Do NOT use TypeScript. All files must be `.js` (e.g. `page.js`).
2. UI Pages Locations to Create:
   - `src/app/todos/page.js`
   - `src/app/emergency-contacts/page.js`
   - `src/app/warranty/page.js`
   - `src/app/rentals/page.js`
3. UI Page Design & Styling (Vesta theme compliance):
   - Align with existing pages like `src/app/medical/page.js`.
   - Layout contains:
     - Top header with page title and an "Add" button (using Lucide icons like Plus, UserPlus, etc.).
     - A search input and filters (e.g., status filter for Todos, category filter for others).
     - A list view or table to display records.
     - Responsive tables/cards styled with Tailwind, supporting sorting/filtering.
     - A dialog/modal (using Dialog / Select / input components from `@/components/ui/...`) for Add and Edit operations.
     - For dates, use standard date picker. Display dates consistently using `dd/mm/yyyy` format (or `.toLocaleDateString('en-GB')` which outputs `dd/mm/yyyy` format, e.g. `15/07/2026`).
     - Display action options for records: Share (native share/copy link), Print/PDF, and Delete. Use helpers in `@/lib/sharePrintHelper.js` where appropriate (like in medical records or passwords page).
4. Sidebar Navigation in `src/app/components/Shell.js`:
   - Restore the "Family Members" link under "Family Folders" pointing to `/users` with the `Users` icon.
   - Update To-Dos: path `/todos`, icon `ListTodo` under "Family Folders".
   - Update Emergency Contacts: path `/emergency-contacts`, icon `PhoneCall` under "Care & Safety" (update the old `/emergency` path).
   - Update Warranty & AMC: path `/warranty`, icon `ShieldCheck` under "Utilities".
   - Update Rentals & Subscriptions: path `/rentals`, icon `FileSignature` under "Utilities" (update the old `/contracts` path).
   - Verify that the collapsible sidebar logic continues to work perfectly (shrinking to 72px, hiding labels, displaying icons only).
5. Route Guarding in `Shell.js`:
   - Update the `tenantSpecificPaths` array inside the `SUPER_ADMIN` route guard in `Shell.js` to block access to the new routes (`/todos`, `/emergency-contacts`, `/warranty`, `/rentals`).
6. API Integration:
   - Perform fetches to the respective API routes: `/api/todos`, `/api/emergency-contacts`, `/api/warranty`, `/api/rentals`.
   - Support creating, updating, and deleting records.
   - For Warranty & AMC and Rentals & Subscriptions, support file uploads in the forms (sending file in FormData to the backend API).
   - Add the visual structure for the "Auto-fill with AI" button next to file uploads in forms (e.g., loading state and calling the scan endpoint, which we will fully wire up and test in Milestone 3).

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
