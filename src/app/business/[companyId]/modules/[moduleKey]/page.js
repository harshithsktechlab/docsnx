'use client';

/**
 * `/business/<companyId>/modules/<moduleKey>` — one company's module overview.
 *
 * The company is in the PATH rather than in a cookie or component state, so two
 * companies can be open in two tabs, a link carries the company it belongs to,
 * and a refresh lands where the user was. `ModuleOverview` reads it straight
 * off `useParams`.
 *
 * Nothing here is a permission: the id in the URL is untrusted, and every
 * request it produces is re-proven server-side by `hasCompanyAccess`.
 */
import ModuleOverview from '@/app/components/ModuleOverview';

export default function BusinessModuleOverviewPage() {
  return <ModuleOverview />;
}
