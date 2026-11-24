'use client';

/**
 * `/business/<companyId>/clients/configure?type=individual|company` — choose which
 * document types this company keeps for each kind of client.
 *
 * `useSearchParams` needs a Suspense boundary under the App Router, so the
 * wrapper provides one around the screen that reads it.
 */
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import ClientConfigure from '@/app/components/clients/ClientConfigure';

function Inner() {
  const type = useSearchParams().get('type');
  return <ClientConfigure initialType={type === 'company' ? 'company' : 'individual'} />;
}

export default function BusinessClientConfigurePage() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
