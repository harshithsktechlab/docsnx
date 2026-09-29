# Handoff Report: Client-Side Route Guards for SUPER_ADMIN in Shell.js

## 1. Observation
From our code analysis of the files under `src/app`, we observed the following:

- **User State and Role Checking in `src/app/components/Shell.js`:**
  - The authenticated user details are retrieved in `Shell.js` (lines 86–95) using the client-side helper function `clientGetMe()`:
    ```javascript
    async function loadUser() {
      const data = await clientGetMe();
      if (!data.success) {
        if (pathname !== '/login' && pathname !== '/register') router.push('/login');
      } else {
        setUser(data.user);
        if (pathname === '/login' || pathname === '/register') router.push('/dashboard');
      }
      setLoading(false);
    }
    ```
  - The `SUPER_ADMIN` check is defined in lines 240–241:
    ```javascript
    const isAdmin = user?.role === 'TENANT_ADMIN' || user?.role === 'SUPER_ADMIN';
    const isSuperAdmin = user?.role === 'SUPER_ADMIN';
    ```

- **App Layout & Page Routes:**
  - Standard user/tenant-specific pages and directories exist directly under `src/app/`. Running `find_by_name` for `page.js` revealed flat page structures:
    - `/documents` (`src/app/documents/page.js`)
    - `/medical` (`src/app/medical/page.js`)
    - `/passwords` (`src/app/passwords/page.js`)
    - `/bank-info` (`src/app/bank-info/page.js`)
    - `/trading` (`src/app/trading/page.js`)
    - `/vehicles` (`src/app/vehicles/page.js`)
    - `/lic-mediclaim` (`src/app/lic-mediclaim/page.js`)
    - `/investments` (`src/app/investments/page.js`)
    - `/profile` (`src/app/profile/page.js`)
    - `/users` (`src/app/users/page.js`)
    - `/dashboard/bulk-scan` (`src/app/dashboard/bulk-scan/page.js`)
  
  - Shared pages with custom layouts per role:
    - `/dashboard` (`src/app/dashboard/page.js` & `src/app/api/dashboard/route.js`) -> returns admin stats dashboard if user is `SUPER_ADMIN` (lines 12–55 of `src/app/api/dashboard/route.js`).
    - `/more` (`src/app/more/page.js`) -> displays tenant-specific records modules to non-admins and administrative links to `SUPER_ADMIN`.
    - `/whatsapp` (`src/app/whatsapp/page.js`) -> console for WhatsApp automation shared by admins.
    - `/audit-logs` (`src/app/audit-logs/page.js`) -> shared system events log.

- **Available Admin Page Routes:**
  - Running a search for `*admin*` under `src/app` returned only the API folder `src/app/api/admin`. The frontend page path for managing tenants is `/tenants` (`src/app/tenants/page.js`), which already enforces SUPER_ADMIN access:
    ```javascript
    // src/app/tenants/page.js:38
    if (!me.success || me.user.role !== 'SUPER_ADMIN') { router.push('/dashboard'); return; }
    ```

- **Routing & Navigation Hook:**
  - `Shell.js` instantiates Next.js `useRouter()` at line 41:
    ```javascript
    const router = useRouter();
    ```

---

## 2. Logic Chain
1. Since the `User` model in `prisma/schema.prisma` maps users to a `tenantId`, a `SUPER_ADMIN` might have an associated `tenantId` but they must not interact with tenant-specific records (e.g. documents, medical files, passwords) in the UI.
2. The flat routes `/documents`, `/medical`, `/passwords`, `/bank-info`, `/trading`, `/vehicles`, `/lic-mediclaim`, `/investments`, `/profile`, `/users`, and `/dashboard/bulk-scan` contain no global system-admin components and are designated only for family/tenant members.
3. Therefore, if the client-side pathname belongs to any of these tenant-specific paths, and the logged-in user has the `SUPER_ADMIN` role, they must be redirected.
4. Redirection to `/admin/tenants` is not possible since that page route does not exist. The corresponding frontend page is `/tenants` (`src/app/tenants/page.js`), which is specifically designed for `SUPER_ADMIN` tenant management.
5. In Next.js client-side routing, calling `router.replace('/tenants')` inside a `useEffect` monitoring changes to `user` and `pathname` will safely redirect the user without polluting the browser history (thus avoiding back-navigation traps).

---

## 3. Caveats
- `/dashboard` contains an Admin View (`isAdminDashboard: true`) that provides global system indicators (total tenants, total users, AI API keys, WhatsApp log count). Since it serves as the admin dashboard home screen, `SUPER_ADMIN` must NOT be redirected away from it.
- `/more` contains dynamic navigation blocks that hide standard tenant files and reveal global admin configurations for `SUPER_ADMIN`. Hence, `/more` does not require redirection.
- Deep nested URLs (should they be added in the future, e.g., `/documents/view/1`) must also be caught by checking if the path starts with the base route prefix (e.g. `pathname.startsWith('/documents/')`).

---

## 4. Conclusion
1. **Tenant-Specific URLs to guard:**
   - `/documents`
   - `/medical`
   - `/passwords`
   - `/bank-info`
   - `/trading`
   - `/vehicles`
   - `/lic-mediclaim`
   - `/investments`
   - `/profile`
   - `/users`
   - `/dashboard/bulk-scan`

2. **SUPER_ADMIN check in `Shell.js`:**
   Check the `user?.role === 'SUPER_ADMIN'` condition after the session loads.

3. **Performing the Redirect:**
   Perform the redirect using `router.replace('/tenants')` (as `/admin/tenants` does not exist). Alternatively, `/dashboard` is also safe.

### Proposed Code Implementation in `src/app/components/Shell.js`
Add the following `useEffect` hook to implement the client-side route guard:

```javascript
  // Route guard to redirect SUPER_ADMIN users away from tenant-specific URLs
  useEffect(() => {
    if (user?.role === 'SUPER_ADMIN') {
      const tenantSpecificPaths = [
        '/documents',
        '/medical',
        '/passwords',
        '/bank-info',
        '/trading',
        '/vehicles',
        '/lic-mediclaim',
        '/investments',
        '/profile',
        '/users',
        '/dashboard/bulk-scan'
      ];

      const isTenantRoute = tenantSpecificPaths.some(path => 
        pathname === path || pathname.startsWith(path + '/')
      );

      if (isTenantRoute) {
        router.replace('/tenants');
      }
    }
  }, [user, pathname, router]);
```

---

## 5. Verification Method
- **Verification Commands:** Run Next.js build using `npm run build` to ensure there are no compilation/syntax issues. Playwright integration tests (if any are configured under `playwright.config.ts`) can be run using `npx playwright test`.
- **Files to Inspect:** Inspect `src/app/components/Shell.js` after changes to confirm the hook is correctly inserted under the user load logic.
- **Invalidation Conditions:** The redirect guard is invalidated if a new tenant-specific route is added under `src/app/` but not added to the `tenantSpecificPaths` list, or if the `SUPER_ADMIN` role name is changed in `schema.prisma`.
