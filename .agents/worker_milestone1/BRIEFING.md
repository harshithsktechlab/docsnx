# BRIEFING — 2026-07-04T08:40:02Z

## Mission
Build the Next.js API route handlers (GET, POST, PUT, DELETE) in JavaScript for Todo, EmergencyContact, WarrantyAmc, and ContractAgreement modules.

## 🔒 My Identity
- Archetype: worker
- Roles: implementer, qa, specialist
- Working directory: d:\Apps\familyos\.agents\worker_milestone1
- Original parent: d2d83ac3-7339-4d2b-a7bd-20ced030218d
- Milestone: milestone1

## 🔒 Key Constraints
- JavaScript Only: Do NOT use TypeScript. Files must be .js.
- Ensure strict tenant isolation: Every database query MUST filter by tenantId.
- Block SUPER_ADMIN role access to tenant endpoints.
- Parse JSON for Todo & EmergencyContact; parse Multipart FormData for WarrantyAmc & ContractAgreement.
- Check permissions with `hasPermission` before database operations.
- Delete associated old files from disk on update or delete.
- Save audit log records after mutations.

## Current Parent
- Conversation ID: d2d83ac3-7339-4d2b-a7bd-20ced030218d
- Updated: not yet

## Task Summary
- **What to build**: Next.js API route handlers for four new modules.
- **Success criteria**: Implementation of CRUD operations with auth, permissions, isolation, file handling, and audit logging.
- **Interface contracts**: `prisma/schema.prisma`, `@/lib/auth`, `@/lib/upload`, `@/lib/db`.
- **Code layout**: API routes located in `src/app/api/...`.

## Key Decisions Made
- Use standard JS Next.js Route Handlers with async `params`.
- Leverage standard `getUserFromRequest` and `hasPermission` for auth/permissions.
- Handle role-based scoping (TENANT_ADMIN vs. STANDARD) as requested.
- Build flexible parsing supporting both multipart/form-data and application/json.
- Implement robust query filter builders using array conditions.

## Artifact Index
- `src/app/api/todos/route.js`
- `src/app/api/todos/[id]/route.js`
- `src/app/api/emergency-contacts/route.js`
- `src/app/api/emergency-contacts/[id]/route.js`
- `src/app/api/warranty/route.js`
- `src/app/api/warranty/[id]/route.js`
- `src/app/api/rentals/route.js`
- `src/app/api/rentals/[id]/route.js`

## Change Tracker
- **Files modified**:
  - `src/app/api/todos/route.js` - CRUD list and create
  - `src/app/api/todos/[id]/route.js` - CRUD detail, edit, delete
  - `src/app/api/emergency-contacts/route.js` - CRUD list and create
  - `src/app/api/emergency-contacts/[id]/route.js` - CRUD detail, edit, delete
  - `src/app/api/warranty/route.js` - CRUD list and create with file upload
  - `src/app/api/warranty/[id]/route.js` - CRUD detail, edit, delete with file cleanup
  - `src/app/api/rentals/route.js` - CRUD list and create with file upload
  - `src/app/api/rentals/[id]/route.js` - CRUD detail, edit, delete with file cleanup
- **Build status**: Linting passed. Build running.
- **Pending issues**: None.

## Quality Status
- **Build/test result**: Linting passed.
- **Lint status**: 0 errors, 10 external warnings.
- **Tests added/modified**: None.
