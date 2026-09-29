## 2026-07-04T08:38:07Z
Objective: Build the Next.js API route handlers (GET, POST, PUT, DELETE) in JavaScript for the four new modules: Todo, EmergencyContact, WarrantyAmc, and ContractAgreement.

Directory: d:\Apps\familyos
Your Working Directory: d:\Apps\familyos\.agents\worker_milestone1
Your Identity: worker (Backend API Developer)

Requirements:
1. JavaScript Only: Do NOT use TypeScript. Files must be .js.
2. Route Paths:
   - Todo: `src/app/api/todos/route.js` and `src/app/api/todos/[id]/route.js`
   - EmergencyContact: `src/app/api/emergency-contacts/route.js` and `src/app/api/emergency-contacts/[id]/route.js`
   - WarrantyAmc: `src/app/api/warranty/route.js` and `src/app/api/warranty/[id]/route.js`
   - ContractAgreement: `src/app/api/rentals/route.js` and `src/app/api/rentals/[id]/route.js`
3. Authentication & Security:
   - Always call `getUserFromRequest(req)` from `@/lib/auth`. If no user is found, return `NextResponse.json({ error: 'Unauthorized' }, { status: 401 })`.
   - Always check permissions using `hasPermission(user, module, action)` from `@/lib/auth` before executing any query or mutation.
     - Permission module mapping:
       - Todo: module name 'todos'
       - EmergencyContact: module name 'emergency'
       - WarrantyAmc: module name 'warranty'
       - ContractAgreement: module name 'contracts'
     - Return `NextResponse.json({ error: 'Forbidden' }, { status: 403 })` if not allowed.
   - Guard against `SUPER_ADMIN`: they must not be allowed to access these tenant-specific endpoints. `hasPermission` naturally blocks this for SUPER_ADMIN, but explicitly double-check that no queries execute if role is SUPER_ADMIN.
4. Tenant Isolation:
   - Every database query (findMany, findFirst, create, update, delete) MUST include `tenantId: user.tenantId` in the where filter. Never query without filtering by `tenantId`.
   - If querying a single item by `id` (e.g. in `[id]/route.js`), find the record using `findFirst` with `{ id, tenantId: user.tenantId }`. If not found, return `404 Not Found`.
   - For `STANDARD` users, ensure they can only query/edit/delete records owned by them if required, or follow the module-specific access check. For medical, standard users can only view their own records (`userId: user.id`), unless a target `userId` is supplied and they have general view access. Let's do the same for todos, emergency contacts, warranty, and contracts:
     - GET (list): For `STANDARD` users, filter by `userId` (holderId / assigneeId / creatorId) as appropriate, or allow them to view all records in the tenant if they have permission. Wait, in medical route, standard users are filtered to `userId = user.id`. For the new modules, since they are family-wide utilities, standard users should see their own records or the global records, or if they have permission, see what's filtered. Let's check `isGlobal`.
     - Wait, for `Todo`: `assigneeId` and `creatorId`. Standard user can see todos assigned to them or created by them.
     - For `EmergencyContact`: emergency contacts don't have holderId, they are global to the family (tenantId). So any user with permission can view them.
     - For `WarrantyAmc` and `ContractAgreement`: standard users can see global records (`isGlobal: true`) or records where `holderId = user.id`.
     - Let's make sure the WHERE clause for standard users is:
       - Todo: `where: { tenantId: user.tenantId, OR: [{ assigneeId: user.id }, { creatorId: user.id }] }`. If a target `userId` parameter is specified in the query, check if the request user is allowed to see it.
       - EmergencyContact: `where: { tenantId: user.tenantId }` (since it's a family-wide directory).
       - WarrantyAmc: `where: { tenantId: user.tenantId, OR: [{ isGlobal: true }, { holderId: user.id }] }`.
       - ContractAgreement: `where: { tenantId: user.tenantId, OR: [{ isGlobal: true }, { holderId: user.id }] }`.
       - (And if user role is TENANT_ADMIN, they bypass holder/assignee filters and see all tenant records!).
5. CRUD Implementation Details:
   - GET (list):
     - Support search params (e.g. search / filter by assignee, category, etc.).
     - Include relations:
       - Todo: include `assignee: { select: { name: true } }` and `creator: { select: { name: true } }`.
       - WarrantyAmc / ContractAgreement: include `holder: { select: { name: true } }` if `holderId` exists.
   - POST (create):
     - For Todo & EmergencyContact: parse JSON from `req.json()`.
     - For WarrantyAmc & ContractAgreement: parse Multipart Form Data using `req.formData()` to support file uploads.
     - Save any uploaded file using `saveUploadedFile(file)` from `@/lib/upload`. Save the returned file path to `filePath` field.
     - Save audit log using `prisma.auditLog.create` with corresponding tenantId, userId, action (e.g., 'CREATE_TODO', 'CREATE_EMERGENCY_CONTACT', etc.) and details description.
   - PUT / PATCH (update):
     - Parse JSON or FormData.
     - If a new file is uploaded, delete the old file from disk (using fs.existsSync and fs.unlinkSync on the absolute path `path.join(process.cwd(), 'public', record.filePath)`) and save the new file.
     - Save audit log.
   - DELETE:
     - Delete record from DB.
     - Delete associated file from disk if present.
     - Save audit log.
