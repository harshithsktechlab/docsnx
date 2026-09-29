---
name: consistency-enforcer
description: >
  Automatically triggered whenever any new module, page, API route, or major feature is created or modified.
  Orchestrates all DocsNX project standards — module registry, permissions, deduplication,
  AI privacy shield, and audit logging — to prevent regression of existing features.
---

# Consistency Enforcer

This skill is the **master gatekeeper** for DocsNX. It prevents the most common failure mode:
an AI agent adding or changing a feature and silently breaking previously working modules
because it regenerated a file from its context window memory instead of reading the actual file.

---

## Trigger Conditions

You MUST activate this skill whenever you are:

1. **Creating a new module** (new page under `src/app/`, new API route under `src/app/api/`)
2. **Modifying `Shell.js`** in any way
3. **Modifying `src/app/users/page.js`** in any way
4. **Modifying `src/lib/moduleRegistry.js`**
5. **Adding a new database table** (schema changes)
6. **Any task described as a "major change" or "refactor"**

---

## Step 1 — Read the Registry First (MANDATORY)

Before writing any code, you MUST read the current state of the module registry:

```
src/lib/moduleRegistry.js
```

This is the **single source of truth** for all modules. It controls:
- What appears in the sidebar (via `NAV_MODULES`)
- Which paths SUPER_ADMIN is blocked from (via `TENANT_SPECIFIC_PATHS`)
- Which modules have permission rows in the DB (via `PERMISSION_MODULE_KEYS`)
- What default permissions new users receive (via `DEFAULT_USER_PERMISSIONS`)

**Never regenerate `navGroups` or `tenantSpecificPaths` from memory.** Always derive from the registry.

---

## Step 2 — The 4-Point Consistency Checklist

Run through each point for every change:

### 2A — Module Registry Sync
If you are adding a new module:
- [ ] Add it to `NAV_MODULES` in `src/lib/moduleRegistry.js` (correct group, key, path, name)
- [ ] Add its icon to `MODULE_ICON_MAP` in `Shell.js` (key = the module path field)
- [ ] Verify `PERMISSION_MODULE_KEYS` now includes the new module key
- [ ] **Do NOT** touch `defaultAddPerms` or `modules` in `users/page.js` — auto-derived
- [ ] **Do NOT** touch `tenantSpecificPaths` in `Shell.js` — auto-derived

If a module is NOT in the sidebar (e.g., a system utility), set `group: null` in the registry
and manually add its key to `PERMISSION_MODULE_KEYS` at the bottom of the registry file.

### 2B — Permissions Enforcement (invoke permissions-enforcer skill)

**Backend (every POST, PUT, DELETE):**
```typescript
const allowed = await hasPermission(user, 'your_module_key', 'add');
if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
```

**Frontend (every list/detail page):**
```javascript
const perm = u.permissions?.find(p => p.module === 'your_module_key');
const canAdd    = u.role === 'TENANT_ADMIN' || u.role === 'SUPER_ADMIN' || perm?.canAdd;
const canEdit   = u.role === 'TENANT_ADMIN' || u.role === 'SUPER_ADMIN' || perm?.canEdit;
const canDelete = u.role === 'TENANT_ADMIN' || u.role === 'SUPER_ADMIN' || perm?.canDelete;
// Wrap all action buttons: {canAdd && <Button>Add</Button>}
```

### 2C — Deduplication (invoke deduplication-enforcer skill)
- Backend: check duplicates on POST/PUT, return 409 { requiresConfirmation: true }
- Frontend: catch 409, show confirm dialog, resend with forceSave: true

### 2D — Zero-Trust Privacy Shield (invoke zero-trust-privacy-shield skill)
- Wrap AI payloads with prepareAiPayload() before sending to LLM
- Add new tables to driveSync.ts for Google Drive sync
- Encrypt sensitive fields via src/lib/encryption.js before DB writes

---

## Step 3 — Audit Logging

Every state-changing API route (POST, PUT, DELETE) MUST write an audit log:

```typescript
await db.insert(auditLog).values({
  tenantId: user.tenantId,
  userId:   user.id,
  action:   'module_name.created',
  details:  JSON.stringify({ id: record.id }),
  ipAddress: req.headers.get('x-forwarded-for') || 'unknown',
});
```

---

## Step 4 — Tenant Isolation

Every DB query on a tenant-scoped table MUST include a tenantId filter:

```typescript
// Correct
const records = await db.query.myTable.findMany({
  where: (t, { eq, and }) => and(eq(t.tenantId, user.tenantId), eq(t.id, id)),
});
```

---

## Step 5 — Pre-Commit Verification Checklist

- [ ] src/lib/moduleRegistry.js is the ONLY file where module names/paths were changed
- [ ] Shell.js navGroups is still derived from NAV_MODULES (not hardcoded)
- [ ] users/page.js defaultAddPerms is still DEFAULT_USER_PERMISSIONS from registry
- [ ] users/page.js handleSelectUser uses PERMISSION_MODULE_KEYS (not a hardcoded array)
- [ ] Every new API route has getUserFromRequest + hasPermission guards
- [ ] Every new UI page fetches user permissions and conditionally renders action buttons
- [ ] Audit log entry written for every mutation
- [ ] All DB queries include tenantId filter

---

## CRITICAL WARNING FOR AI AGENTS

NEVER regenerate a large file (like Shell.js at 989+ lines) by rewriting it entirely.
Always use targeted, minimal edits (multi_replace_file_content).
Rewriting from memory silently drops modules that were added in previous sessions
but are absent from the current context window.
