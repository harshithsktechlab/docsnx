'use client';

/** `/business/<companyId>/clients/<clientId>` — one client and their documents. */
import { Suspense } from 'react';
import ClientDetail from '@/app/components/clients/ClientDetail';

// The documents table keeps its search / filter / page in the URL (useSearchParams).
export default function BusinessClientPage() {
  return <Suspense fallback={null}><ClientDetail /></Suspense>;
}
