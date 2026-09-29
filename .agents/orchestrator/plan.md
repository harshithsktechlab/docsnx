# Implementation Plan: familyos Enterprise Features

This plan defines the step-by-step implementation roadmap for completing the remaining enterprise features: AI Portfolio Analysis, SMTP Password Reset, Card UI Refactoring, and Razorpay Payments Integration.

## Milestones

### Milestone 1: DB Schema & Mock Data Setup
- Modify `prisma/schema.prisma` to add password reset token fields to the `User` model:
  - `resetToken String? @map("reset_token") @db.VarChar(255)`
  - `resetTokenExpiry DateTime? @map("reset_token_expiry")`
- Run database migrations: `npx prisma migrate dev --name add_reset_token`
- Create `scripts/mock_tenant_data.js` to seed a mock tenant with intentional portfolio gaps:
  - Missing health insurance (no `LicMediclaim` records with `policyType = "mediclaim"`).
  - Bad investments (e.g. `purchaseValue` significantly higher than `currentValue`).
  - Expired policies (e.g. a `vehicle` with `insuranceExpiry` or `pucExpiry` in the past).
  - Use Prisma Client in the script to run locally.

### Milestone 2: AI Portfolio Analysis
- Create `src/app/api/analysis/route.js` (GET) backend route:
  - Query all relevant modules for the tenant: `medicalRecord`, `investment`, `licMediclaim`, `document`, `vehicle`, `warrantyAmc`, `contractAgreement`.
  - Format the aggregated records into a text representation.
  - Formulate an AI prompt analyzing gaps, expired items, and investment issues.
  - Call Gemini/OpenAI using `executeTenantWithRotation(user.tenantId, ...)` via `src/lib/ai.js`.
  - Return the response as structured JSON containing categories: `gaps`, `investments`, `expiry`, and `recommendations`.
- Create `src/app/analysis/page.js`:
  - Highly polished dashboard displaying the gaps explicitly using cards, visual badges (red/yellow indicators), and recommendations.
  - Use Tailwind CSS v3 Vesta theme.
- Add navigation link:
  - Add "AI Analysis" (`/analysis`) to `src/app/components/Shell.js` under the "Overview" section.
  - Add "AI Portfolio Analysis" link to `src/app/more/page.js`.

### Milestone 3: SMTP Password Reset Flow
- Add `nodemailer` package to `package.json`.
- Implement API routes:
  - `/api/auth/forgot-password/route.js` (POST): Receive email, generate reset token & expiry, save to database, send email with reset link containing `?token=XYZ` using SMTP from `SystemConfig` via `nodemailer`.
  - `/api/auth/reset-password/route.js` (POST): Receive token and newPassword, query user, hash new password using `bcryptjs`, update database, clear token.
  - Note: Support offline logs/output if SMTP connection is not reachable in the restricted network environment so that testing can proceed.
- Implement UI routes:
  - `/forgot-password/page.js`: Email input, submit, show success state.
  - `/reset-password/page.js`: Retrieve token from URL, password input, submit, redirect to login.

### Milestone 4: Card UI Refactoring & AI Auto-fill
- Refactor card faces across all record modules:
  - Expose exactly two prominent actions on the card face: "Share" (invokes native share or copy link) and "Download as PDF" (using `sharePrintHelper`'s print style or PDF export).
  - Move "Edit", "Delete", "Preview File" actions to a secondary dropdown menu.
  - Apply to: Documents, Medical, Passwords, Bank Info, Trading, Investments, Vehicles, LIC & Mediclaim, To-Dos, Emergency Contacts, Warranty/AMC, Rentals/Subscriptions.
- Integrate "Extract with AI" / "Auto-fill with AI" button into the file upload section of all forms (ensuring it is easily accessible).

### Milestone 5: Razorpay & Verification
- Add `razorpay` package to `package.json`.
- Implement `scripts/test_razorpay.js` to programmatically test Razorpay order and subscription generation using test credentials.
- Stub/mock external Razorpay API requests in the test script so it works perfectly in the offline network environment.
- Run `npm run build` and E2E tests to verify layout conformance, build stability, and lack of compiler errors.
