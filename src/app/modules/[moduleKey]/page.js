'use client';

/**
 * `/modules/<moduleKey>` — the PERSONAL module overview.
 *
 * A thin route. The implementation is shared with the business workspace at
 * `/business/<companyId>/modules/<moduleKey>`, which renders the same component
 * and differs only in the `companyId` route param it supplies.
 */
import ModuleOverview from '@/app/components/ModuleOverview';

export default function ModuleOverviewPage() {
  return <ModuleOverview />;
}
