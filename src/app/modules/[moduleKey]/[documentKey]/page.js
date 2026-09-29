'use client';

/**
 * `/modules/<moduleKey>/<documentKey>` — the PERSONAL sub-category workspace.
 *
 * A thin route; the implementation is shared with the business workspace at
 * `/business/<companyId>/modules/<moduleKey>/<documentKey>`.
 */
import SubCategoryWorkspace from '@/app/components/SubCategoryWorkspace';

export default function SubCategoryPage() {
  return <SubCategoryWorkspace />;
}
