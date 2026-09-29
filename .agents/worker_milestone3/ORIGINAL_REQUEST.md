## 2026-07-04T14:14:21Z

Objective: Integrate AI OCR scanning ("Auto-fill with AI") into the newly created form pages (`/todos`, `/emergency-contacts`, `/warranty`, `/rentals`) by updating the AI system prompt in `src/lib/ai.js`, hooking up the frontend forms to call `/api/ai/scan`, and extending the bulk scan save endpoint `/api/ai/scan/save/route.js`.

Directory: d:\Apps\familyos
Your Working Directory: d:\Apps\familyos\.agents\worker_milestone3
Your Identity: worker (AI Integration Developer)

Requirements:
1. JavaScript Only: Do NOT use TypeScript. All files must be `.js`.
2. Update AI Utility (`src/lib/ai.js`):
   - Modify the `systemPrompt` inside `scanMultipleFiles` (around lines 153-192) to support the four new categories: `todo`, `emergency_contact`, `warranty_amc`, `contract_agreement`.
   - Update the categories list and detailed schema descriptions:
     - `todo`: `{ "task": string, "dueDate": "YYYY-MM-DD", "status": "PENDING"|"COMPLETED" }`
     - `emergency_contact`: `{ "name": string, "role": string, "phoneNumber": string, "email": string, "address": string, "notes": string }`
     - `warranty_amc`: `{ "applianceName": string, "company": string, "type": "WARRANTY"|"AMC", "purchaseDate": "YYYY-MM-DD", "expiryDate": "YYYY-MM-DD", "supportContact": string, "notes": string }`
     - `contract_agreement`: `{ "type": "RENTAL"|"MAINTENANCE"|"UTILITY"|"SUBSCRIPTION", "name": string, "provider": string, "accountNumber": string, "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "amount": number, "billingCycle": "monthly"|"yearly"|"other", "notes": string }`
3. Update Bulk Scan Save Route (`src/app/api/ai/scan/save/route.js`):
   - Extend the `POST` handler to support the new categories (`todo`, `emergency_contact`, `warranty_amc`, `contract_agreement`) when records are bulk saved.
   - Map their `extractedData` fields to the corresponding Prisma model creations:
     - `todo` -> `prisma.todo`
     - `emergency_contact` -> `prisma.emergencyContact`
     - `warranty_amc` -> `prisma.warrantyAmc`
     - `contract_agreement` -> `prisma.contractAgreement`
   - Include relations, tenantId, userId, holderId, isGlobal, and write audit logs.
4. Frontend Form Integration:
   - Go to:
     - `src/app/todos/page.js`
     - `src/app/emergency-contacts/page.js`
     - `src/app/warranty/page.js`
     - `src/app/rentals/page.js`
   - Wire up the "Auto-fill with AI" button in the form:
     - The button must require that a file is first selected. If no file is selected, show an error alert.
     - When clicked, append the selected file to a `FormData` object and call the POST endpoint `/api/ai/scan`.
     - Show a loading/scanning state (e.g. loading spinner and text) while the scan is running.
     - On success, extract the first record from `json.proposedRecords` and map its properties onto the form's local states. Make sure to gracefully format dates if returned in ISO or other formats (e.g., standard format for input type="date" is `YYYY-MM-DD`).
     - Display a success message or clear the error on success.
5. Verify and Build:
   - Run `npm run build` to verify the build compiles cleanly without any warnings or errors.
