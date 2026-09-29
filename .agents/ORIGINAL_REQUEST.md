# Original User Request

## Initial Request — 2026-07-04T07:30:51Z

# Teamwork Project Prompt

This project, familyos, is a multi-tenant family management SaaS platform deployed on Oracle Cloud OCI (simulated locally) built with Next.js 15, React 19, Prisma, PostgreSQL, and Tailwind CSS. The objective is to overhaul the features, database, security, and UI/UX by removing WhatsApp integration, implementing a robust follow-up and notification system, adding AI document text extraction, tracking tenant AI API keys and usage, and establishing a unified design system using the cozy **Vesta** theme.

Working directory: d:/Apps/familyos
Integrity mode: development

## Requirements

### R1. Remove WhatsApp Integration
Remove all references, page routes, background workers (`scripts/whatsapp-worker.mjs`), and database configurations/models for WhatsApp from the codebase.

### R2. Refined Tenant Isolation & Super Admin Permissions
Super Admins must not be able to access individual tenant records (e.g. documents, medical records, bank details). Maintain strict tenant isolation at the database layer (Prisma client queries and middleware/checks) and UI routes.

### R3. Dynamic Design System & Unified Layout (Vesta Theme)
Create a clean, beautiful, and complete design system using curated CSS tokens (Tailwind CSS v3 + CSS variables) with responsive, premium layouts.
- Adopt a cozy, premium Terracotta (`#e07a5f`) & Sand (`#f4f1de`) branding theme.
- Create a collapsible sidebar navigation (which shrinks to 72px showing only icons on collapse).
- Group navigation into five distinct categories: Overview, Family Folders, Care & Safety, Wealth & Assets, and Utilities.
- Include a unified branding profile/logo design.

### R4. Standardized Date & Document Model
Implement standard date format (dd/mm/yyyy) across all components. Differentiate between global family-wide records and user-specific records. Add a nullable `holderId` (pointing to User) and `isGlobal` boolean column across all record models, enforcing holder-level and global visibility constraints.

### R5. Follow-Up & Notification Module
Create a follow-up module to aggregate pending tasks (renewals, missing insurance cover, missing documents, birthdays). Display counts and badges on the collapsible side panel. Implement temporary, dismissible notifications that redirect to specific records.

### R6. AI Feature Enhancements
Provide AI-powered analysis for missing cover, bad policies, bad vehicle insurance, bad investments, and health recommendations based on medical records. Add local AI text extraction ("Auto-fill with AI") next to file uploads in forms.

### R7. Tenant-level API Keys & Super Admin Dashboard
Replace tenant slug with tenant-specific API key tracking. The Super Admin dashboard must display tenant-wise AI Token consumption, SMTP settings, pricing plans/yearly subscriptions, and a simulated payment integration (with Razorpay sandbox checkout), while omitting system-wide activity logs.

### R8. Local Storage & Backup Options
Provide tenants an option to keep all data on the local device with JSON backup/restore capabilities.

## Acceptance Criteria

### Security & Isolation
- [ ] Super admin role is blocked from viewing tenant-specific data pages or querying tenant data (API throws 403).
- [ ] Direct database queries inside Next.js routes verify `tenantId` match against current authenticated user.

### Features & Functionality
- [ ] Date picker and display values consistently use `dd/mm/yyyy` format.
- [ ] Uploaded documents support OCR/text extraction using the configured tenant AI keys.
- [ ] Share cards display only 2 options: "Share" (native mobile share or fallback copy link) and "Download as PDF".
- [ ] Local backup files (JSON) can be downloaded and restored successfully.
- [ ] All new modules (Emergency, Warranty/AMC, Rentals/Subscriptions, To-Dos) are fully operational with their respective pages and APIs.

## Follow-up — 2026-07-04T14:05:14+05:30

Implement the missing frontend pages and backend API CRUD routes for four newly added database modules (To-Dos, Emergency Contacts, Warranty & AMC, and Rentals & Subscriptions), and restore the Family Members permissions management module in the familyos Next.js application.

Working directory: d:/Apps/familyos
Integrity mode: development

## Requirements

### R1. Backend API Routes
Build the Next.js API route handlers (GET, POST, PUT, DELETE) for the four modules (`Todo`, `EmergencyContact`, `WarrantyAmc`, `ContractAgreement`). Ensure strict tenant isolation by filtering all database queries with the authenticated user's `tenantId`.

### R2. Frontend UI Implementation
Create the React components for `/todos`, `/emergency-contacts`, `/warranty`, and `/rentals`. The UI must exactly match the design of existing modules (e.g., `/documents`), using data tables for listing and a side drawer or modal for Add/Edit operations, following the Vesta design system.

### R3. File Attachments & AI OCR Support
Include file upload capabilities for these modules. Integrate the existing AI OCR extraction features ("Auto-fill with AI") into the add/edit forms, allowing users to upload documents (like warranty bills or rental agreements) and have fields automatically populated using the existing AI scanning endpoints.

### R4. Restore Family Members & Permissions
Restore the link to the existing `/users` permissions management page in the sidebar under "Family Folders" (named "Family Members"). Verify that the page works correctly, matches the Vesta theme, and successfully allows Tenant Admins to add new family members and configure their granular access permissions.

## Acceptance Criteria

### Security & Verification
- [ ] API routes must return `403 Forbidden` if accessed by a Super Admin or without a valid tenant session.
- [ ] Direct database queries inside the API routes MUST verify a `tenantId` match.
- [ ] The forms must successfully trigger AI OCR extraction and populate fields when a file is uploaded.
- [ ] The Family Members page correctly renders, adds users, updates permissions, and is fully accessible from the sidebar.
- [ ] The Next.js build (`npm run build`) completes successfully without any missing page (404) errors for the new routes.

## Follow-up — 2026-07-04T15:45:56+05:30

# Teamwork Project Prompt — Draft

Complete the remaining enterprise features for FamilyOS, focusing on AI Portfolio Analysis, SMTP Password Reset flows, Razorpay Payments Integration, and UI refactoring for native sharing and PDF downloads.

Working directory: d:/Apps/familyos
Integrity mode: development

## Requirements

### R1. AI Portfolio Analysis
Implement a dedicated AI Analysis Dashboard that aggregates all user records (medical, investments, legal) to identify missing items (e.g., missing life cover, mediclaim gaps, expiring policies). The UI must be highly polished, explicitly highlighting these insights. 

### R2. Secure Authentication Flows
Implement the Forgot Password and Password Reset flows, utilizing the existing SMTP `SystemConfig` configuration to send secure email reset links. 

### R3. Card UI Refactoring & Sharing
Refactor all record cards across the application to display exactly two prominent actions on the card face: "Native Share" (using `navigator.share`) and "Download as PDF". Move all other actions (edit/delete) to a secondary dropdown menu. Ensure the "Extract with AI" button is integrated into the upload flow for every module.

### R4. Razorpay Payment Gateway Integration
Integrate Razorpay for handling one-time platform sales and yearly AI subscription plans with discount support.

## Acceptance Criteria

### AI Portfolio Analysis
- [ ] A programmatic setup script (`scripts/mock_tenant_data.js`) exists and provisions a tenant with intentionally missing mediclaims, bad investments, and expired policies.
- [ ] Running the AI Analysis against this mock tenant successfully flags the missing coverage, bad investments, and expired policies.

### Secure Authentication Flows
- [ ] The `Forgot Password` route successfully generates a reset token in the database and triggers the SMTP mailer logic.
- [ ] The `Reset Password` route consumes the token and successfully updates the user's encrypted password.

### Card UI Refactoring
- [ ] An automated Playwright test or agent-as-judge verifies that the main face of record cards (e.g. Documents, Medical) only exposes "Share" and "Download as PDF" buttons.
- [ ] The `navigator.share` API is correctly invoked when "Share" is clicked on supported devices.

### Razorpay Integration
- [ ] A programmatic test or script successfully generates a Razorpay order ID using test credentials for both a one-time purchase and a recurring subscription plan.

