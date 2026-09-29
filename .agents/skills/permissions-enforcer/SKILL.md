---
name: permissions-enforcer
description: Automatically intercepts any code changes to frontend UI pages or backend API routes and enforces the project's permission standards (both visual hiding of elements and backend checks).
---

# Permissions Enforcer Skill

This skill enforces the DocsNX multi-tenant RBAC (Role-Based Access Control) permissions model across all modules.

## Trigger Conditions
You MUST proactively trigger this skill and apply these rules whenever you are tasked with:
1. Creating or modifying a frontend Page/UI Component (e.g. `src/app/.../page.js`, `StandaloneCards.js`, etc.)
2. Creating or modifying a backend API Route (e.g. `src/app/api/.../route.ts`)

## Rules & Enforcement

### 1. Frontend UI Enforcement (Hiding Buttons)
Standard users should **never** see buttons for actions they are not permitted to perform.
Whenever you build or modify a UI page that lists or manages records, ensure the following:
- Fetch the current user's profile on mount (e.g., using `clientGetMe()`).
- Evaluate the permissions for the specific module using:
  ```javascript
  const perm = u.permissions?.find(p => p.module === 'your_module_name');
  ```
- Store `canAdd`, `canEdit`, `canDelete`, and `canView` flags in component state.
- **Always** wrap `+ Add`, `Edit`, and `Delete` buttons in a conditional rendering block (e.g., `{canAdd && <Button>Add</Button>}`).
- Tenant Admins (`u.role === 'TENANT_ADMIN'`) and Super Admins (`u.role === 'SUPER_ADMIN'`) must always be granted `true` for all these flags, bypassing the `permissions` table check.

### 2. Backend API Enforcement
Never assume the frontend perfectly prevented an unauthorized request. Every state-changing API route (POST, PUT, DELETE) must explicitly verify permissions.
- You must import and `await hasPermission(user, 'your_module_name', 'action')` (from `src/lib/auth.ts`) where `action` is `'add'`, `'edit'`, `'delete'`, or `'view'`.
- If `hasPermission` returns `false`, immediately return a `403 Forbidden` response.
- Example:
  ```typescript
  const allowed = await hasPermission(user, 'your_module_name', 'add');
  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  ```

### 3. New Module Registration
If you are tasked with creating a completely **new** module (e.g., "Inventory" or "Tasks"), you MUST also ensure Tenant Admins have the ability to assign permissions for this module to standard users. 
You must do the following:
1. Add the new module name to the `defaultAddPerms` array in `src/app/users/page.js` so that new users receive default permissions for the module.
2. Add the new module name to the `modules` array (around line 124 in `src/app/users/page.js`) so that it appears in the Edit User modal's permission table.
3. Verify that the new module string exactly matches the `module` argument you pass to `hasPermission` in the backend.
