/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║           MODULE REGISTRY — SINGLE SOURCE OF TRUTH for DocsNX           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The sidebar, the permission matrix and the SUPER_ADMIN route guard all derive
 * from here. Since migration 0023 the record modules are not listed by hand at
 * all — they ARE the master document table in src/lib/documentCategories.ts, in
 * its order, and each renders as an accordion of its sub-categories.
 *
 * ── ADDING A RECORD MODULE ──────────────────────────────────────────────────
 * You do not add one here. Add it to DOCUMENT_CATEGORY_MODULES and give it a
 * scope in src/lib/records/registry.ts; the sidebar, the permission keys and the
 * default permissions all follow. Then add its Lucide icon to MODULE_ICON_MAP in
 * src/lib/moduleIcons.ts — the only per-module thing this file cannot derive.
 *
 * ── ADDING A NON-RECORD MODULE (Passwords, To-Dos, …) ──────────────────────
 *  1. Add an entry to UTILITY_MODULES below.
 *  2. Add its Lucide icon in src/lib/moduleIcons.ts → MODULE_ICON_MAP (keyed by path).
 *
 * ── DO NOT manually edit ────────────────────────────────────────────────────
 *  ✗  defaultAddPerms in src/app/users/page.js   → imported from here
 *  ✗  modules array   in src/app/users/page.js   → imported from here
 *  ✗  tenantSpecificPaths in Shell.js             → imported from here
 *
 * ── FIELD REFERENCE ─────────────────────────────────────────────────────────
 *  key  : matches the `module` string passed to hasPermission() in all API routes
 *  path : the Next.js route (must match a folder under src/app/)
 *  name : display label shown in the sidebar
 * ────────────────────────────────────────────────────────────────────────────
 */
import { DOCUMENT_CATEGORY_MODULES, UNCATEGORIZED, isBusinessModule } from './documentCategories';
import { RECORD_SCOPES, BUSINESS_BASE } from './records/registry';
import { permissionsForLevel } from './permissionLevels';

/**
 * Modules that hold no taxonomy documents — they are not in the master table and
 * have no sub-categories, so they render as plain links, not accordions.
 *
 * A `null` key means admin-managed with no permission row of its own.
 */
export const UTILITY_MODULES = [
  { key: 'profiles',           path: '/profile',            name: 'Profiles'           },
  { key: null,                 path: '/users',              name: 'Members'     },
  { key: 'passwords',          path: '/passwords',          name: 'Passwords'          },
  { key: 'todos',              path: '/todos',              name: 'To-Dos'             },
  { key: 'emergency_contacts', path: '/important-contacts', name: 'Important Contacts' },
];

/**
 * The route prefix for the taxonomy's own pages: `/modules/<moduleKey>` and
 * `/modules/<moduleKey>/<documentKey>`.
 *
 * One page component serves all 83 sub-categories, driven by the taxonomy —
 * there is no per-category route to add when a category is.
 */
export const MODULE_BASE = '/modules';

/**
 * Utility paths that must NEVER take a company prefix.
 *
 * ── EMPTY, AND THAT IS THE POINT ───────────────────────────────────────────
 * It held `/profile` and `/users` while neither had a company route to point
 * at. Both do now, and both needed one:
 *
 *   /users    the member list is per account. A household member and an
 *             employee in one roster is exactly the blur the business account
 *             exists to remove, and the workspace an admin is standing in is
 *             the answer to "which account am I adding this person to".
 *   /profile  a company has an identity of its own — legal name, CIN, GST,
 *             registered address — and there was nowhere at all to record it.
 *             The company page keeps the member's own details as a second tab,
 *             so nothing that used to be reachable stopped being.
 *
 * The constant stays because it is the extension point `utilityNavPath` reads:
 * a utility that genuinely belongs to the whole tenant (Backup & Restore is the
 * standing example — it exports both halves at once) goes here rather than
 * growing a per-module flag. Adding one is a decision to make in front of this
 * comment.
 */
export const COMPANY_UNPREFIXED_PATHS = [];

/**
 * The Workspace group's links for one workspace.
 *
 * Passwords, to-dos and important contacts exist in BOTH accounts, so in a
 * company workspace their links must carry that company — otherwise the sidebar
 * of Acme silently walks the user back into the household's passwords, which is
 * the one place the two accounts must not blur.
 *
 * The prefix is applied by an explicit exclusion list rather than by a
 * per-module flag: a utility added later is company-scoped by default, and the
 * failure mode of that default is a 404 on a missing page, not a link into the
 * wrong account's data.
 */
export function utilityNavPath(path, companyId) {
  if (!companyId || COMPANY_UNPREFIXED_PATHS.includes(path)) return path;
  return `/business/${companyId}${path}`;
}

/** The workspace URL for one sub-category. */
export function subCategoryPath(moduleKey, documentKey) {
  return `${MODULE_BASE}/${moduleKey}/${documentKey}`;
}

/**
 * The 14 master modules, as the sidebar renders them: a flat list in master-table
 * order, each carrying its sub-categories.
 *
 * `path` is where the module header links — the page that owns its first
 * sub-category. `subCategories[].path` is where each row links. Both come from
 * RECORD_SCOPES, so in phase 1 a sub-category still opens the bespoke page that
 * owns it; when phase 2 merges those pages the paths change in one place.
 *
 * `other` is deliberately excluded: it is the catch-all for a scan whose module
 * could not be determined, reachable from the documents list, and a sidebar
 * entry called "Others" alongside 14 real modules would invite filing into it.
 * It IS still a permission key — see PERMISSION_MODULE_KEYS.
 */
/**
 * Shared builder for both rails.
 *
 * The JSDoc type is load-bearing, not decoration: this file is JavaScript, and
 * without it `modules` is implicitly `any`, which propagates out through
 * NAV_MODULES into every TypeScript caller and trips noImplicitAny there
 * instead of here.
 *
 * @param {readonly import('./documentCategories').DocumentCategoryModule[]} modules
 */
const navModulesOf = (modules) => modules
  .filter((m) => m.moduleKey !== UNCATEGORIZED.moduleKey)
  .map((m) => {
    const subCategories = m.subCategories.map((s) => ({
      documentKey: s.documentKey,
      name: s.documentName,
      /**
       * The sub-category's OWN page — a summary, its files, and an add form
       * built from its own field spec.
       *
       * This used to be `pathForCategory(...)`, the bespoke page that owns the
       * category, reached with `?moduleKey=&documentKey=` prefilled. That page
       * shows its whole scope filtered down, which is a different thing from
       * the sub-category as a place: no summary of its own, and an add form
       * belonging to the page rather than to the category the user clicked.
       */
      path: subCategoryPath(m.moduleKey, s.documentKey),
    }));
    return {
      key: m.moduleKey,
      moduleNo: m.moduleNo,
      name: m.moduleName,
      // The module's own landing page: its sub-categories, each with a count.
      // Previously the bespoke page owning its FIRST sub-category, which is why
      // Identity opened the document manager and three modules lit up at once.
      path: `${MODULE_BASE}/${m.moduleKey}`,
      subCategories,
    };
  });

/**
 * The PERSONAL sidebar. Unchanged in meaning from before the business account:
 * the personal modules, catch-all excluded.
 *
 * Business modules are deliberately NOT here. They are not a personal user's
 * navigation, and a tenant on `account_type = 'personal'` must never see
 * fourteen company modules appear in their rail. The business workspace renders
 * BUSINESS_NAV_MODULES instead, under /business/<companyId>.
 */
export const NAV_MODULES = navModulesOf(
  DOCUMENT_CATEGORY_MODULES.filter((m) => !isBusinessModule(m.moduleKey)),
);

/** The BUSINESS sidebar, rendered inside a company workspace. */
export const BUSINESS_NAV_MODULES = navModulesOf(
  DOCUMENT_CATEGORY_MODULES.filter((m) => isBusinessModule(m.moduleKey)),
);

/**
 * Both, for anything that must reason over the whole taxonomy — the permission
 * matrix and PERMISSION_MODULE_KEYS below. A business module still needs a
 * permission key: `hasPermission` denies a STANDARD user outright when no row
 * matches, so a module missing from that list is one nobody can be granted.
 */
export const ALL_NAV_MODULES = [...NAV_MODULES, ...BUSINESS_NAV_MODULES];

// ─── Derived constants (do not edit these directly) ───────────────────────────

/**
 * All paths that SUPER_ADMIN should be blocked from (tenant-specific routes).
 * Used by the route guard in Shell.js.
 *
 * Every scope path is listed, not just the 14 module landing pages: a module
 * links to one page but its sub-categories reach all fifteen, and a path missing
 * here is a tenant page the platform role can open.
 */
export const TENANT_SPECIFIC_PATHS = [
  ...new Set([
    ...UTILITY_MODULES.map((m) => m.path),
    ...Object.values(RECORD_SCOPES).map((s) => s.path),
  ]),
  // The whole module tree in one entry: the guard matches
  // `pathname.startsWith(path + '/')`, so this covers every module landing page
  // and all 83 sub-category workspaces beneath them.
  MODULE_BASE,
  // The whole business workspace, in one entry, for the same reason MODULE_BASE
  // covers the module tree: every company page lives under /business/<id>/.
  BUSINESS_BASE,
  // The scanner now lives at /documents/bulk-scan, which needs no entry of its
  // own: `/documents` is a scope path and the guard in Shell.js matches
  // `pathname.startsWith(path + '/')`. This retained entry covers the redirect
  // stub still served at the old path.
  '/dashboard/bulk-scan',
  // The tenant's own activity trail. Not a scope and not a utility module, so it
  // is not derived above — but it is tenant-owned data that the platform role
  // must never read, and /api/audit-logs denies SUPER_ADMIN outright. Without
  // this entry the guard let them open the page and sit in front of a 403.
  '/audit-logs',
];

/**
 * Module keys that have Permission rows in the database.
 * Used by hasPermission() on all API routes.
 * Null keys (admin-managed nav items) are automatically excluded.
 *
 * NOTE: `other` and invoices are permission-gated even though they have no
 * sidebar nav item, and audit_logs has one only under Account, for TENANT_ADMIN.
 * Every string passed to hasPermission() from an API route MUST appear here —
 * a key that is missing denies STANDARD users outright
 * (hasPermission returns false when no permission row matches), and the bug is
 * invisible in testing because TENANT_ADMIN short-circuits to true.
 * `tests/permissionKeys.test.ts` enforces this.
 */
export const PERMISSION_MODULE_KEYS = [
  ...ALL_NAV_MODULES.map((m) => m.key),
  UNCATEGORIZED.moduleKey, // `other` — grantable, so an unfiled scan is reachable
  ...UTILITY_MODULES.filter((m) => m.key !== null).map((m) => m.key),
  'audit_logs', // sidebar entry is TENANT_ADMIN-only (Account group in Shell.js);
                // /api/audit-logs additionally hard-gates on role
  'invoices',   // reached from Billing, not the sidebar
];

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A MEMBER BELONGS TO ONE ACCOUNT — the key list splits in two           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A member added to work on a company should not also be able to read the
 * household's documents, and vice versa. The enforcement for that already
 * exists and needed no new machinery: `hasPermission` denies outright when no
 * row matches, so a member seeded with only one account's modules is refused
 * every module of the other. The bug was that BOTH accounts' modules were being
 * seeded to everyone.
 *
 * `PERMISSION_MODULE_KEYS` above stays whole — it is what `hasPermission` is
 * asked about and what `tests/permissionKeys.test.ts` checks for completeness.
 * These two are subsets of it, used only to decide what a NEW member gets.
 *
 * They are NOT disjoint: the four utilities below are in both, deliberately.
 * See SHARED_UTILITY_KEYS for what that means and what carries the separation
 * instead.
 */
/**
 * ── THE FOUR THAT BELONG TO BOTH ACCOUNTS ──────────────────────────────────
 *
 * A company needs its own credentials, tasks and important contacts, and every
 * member needs a profile. So these are NOT split between the accounts — they
 * exist in each, and the rows are kept apart by `company_id` exactly as
 * documents are.
 *
 * That is a real change of meaning for the permission: it now says "you may use
 * Passwords", and the company predicate on the query says WHICH passwords. The
 * same two-part answer documents have always had.
 *
 * `profiles` is here for a different reason and is worth not confusing with the
 * others: it is keyed by `user_id`, one row per member, so it is neither
 * personal nor business — it is the member's own details, and everyone has one.
 */
export const SHARED_UTILITY_KEYS = [
  'profiles',
  'passwords',
  'todos',
  'emergency_contacts',
];

export const PERSONAL_PERMISSION_KEYS = PERMISSION_MODULE_KEYS.filter(
  (key) => !isBusinessModule(key),
);

export const BUSINESS_PERMISSION_KEYS = PERMISSION_MODULE_KEYS.filter(
  (key) => isBusinessModule(key) || SHARED_UTILITY_KEYS.includes(key),
);

/**
 * Default permissions for a newly created PERSONAL member.
 * Imported by users/page.js — do not duplicate this array there.
 *
 * MODULE DEFAULTS ONLY: `documentKey` is null on every row, so a new member
 * inherits the same access across all of a module's sub-categories and the admin
 * writes overrides only where one should differ. Seeding all 83 sub-categories
 * would make a category added later invisible instead of inherited.
 *
 * The flags come from the `contribute` rung in permissionLevels.ts rather than
 * being spelled out here, so the registry default and the level the Add-member
 * screen calls "Contributor" cannot drift apart.
 */
export const DEFAULT_PERSONAL_PERMISSIONS = permissionsForLevel(
  PERSONAL_PERMISSION_KEYS,
  'contribute',
);

/**
 * Default permissions for a newly created BUSINESS member.
 *
 * The fourteen company modules plus the four shared utilities. Reaching any
 * actual company still requires a `company_access` row on top of this — these
 * two grains are independent, and a business member with no grant sees an empty
 * switcher.
 *
 * The utilities being here does NOT hand over the household's: every query
 * against those tables carries a company predicate, and a member with no
 * `company_access` row cannot name a company to be scoped to.
 */
export const DEFAULT_BUSINESS_PERMISSIONS = permissionsForLevel(
  BUSINESS_PERMISSION_KEYS,
  'contribute',
);

/** The defaults for one account. `scope` is 'personal' | 'business'. */
export function defaultPermissionsFor(scope) {
  return scope === 'business' ? DEFAULT_BUSINESS_PERMISSIONS : DEFAULT_PERSONAL_PERMISSIONS;
}
