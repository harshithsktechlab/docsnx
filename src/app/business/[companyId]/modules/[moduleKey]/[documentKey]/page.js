'use client';

/**
 * `/business/<companyId>/modules/<moduleKey>/<documentKey>` — one company's
 * sub-category workspace.
 *
 * The company lives in the path, so a link to a record carries the company it
 * belongs to and two companies can be open side by side. The id is untrusted
 * here; every request it produces is re-proven by `hasCompanyAccess`.
 */
import SubCategoryWorkspace from '@/app/components/SubCategoryWorkspace';

export default function BusinessSubCategoryPage() {
  return <SubCategoryWorkspace />;
}
