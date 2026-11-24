'use client';

/**
 * One document type for one client: /business/<companyId>/clients/<clientId>/<documentKey>.
 *
 * The URL names a client and a (derived) document key but no module — the module
 * is the client TYPE's — so this loads the client to learn its type, then renders
 * the ordinary sub-category workspace with the module supplied. The workspace
 * reads the client back off the path for every request it makes
 * (see `clientIdFromPath` in src/lib/net/useWorkspaceApi.ts).
 */
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import PageContainer from '@/app/components/PageContainer';
import SubCategoryWorkspace from '@/app/components/SubCategoryWorkspace';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';
import { CLIENT_MODULE_BY_TYPE } from '@/lib/clientCategories';

export default function ClientSubCategoryPage() {
  const { clientId, documentKey } = useParams();
  const { api, companyId } = useWorkspaceApi();
  const router = useRouter();
  const prefix = `/business/${companyId}`;
  const [client, setClient] = useState(null);
  const [failed, setFailed] = useState(false);
  // How many document types are ticked for this kind of client. Zero means
  // configuring has not been done, and then nothing may be added yet.
  const [configured, setConfigured] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { json } = await api(`/api/clients/${clientId}`);
      if (cancelled) return;
      if (!json.success) { setFailed(true); return; }
      setClient(json.client);
      const cfg = await api(`/api/clients/subcategories?type=${json.client.clientType}`);
      if (!cancelled) setConfigured(cfg.json.success ? cfg.json.enabledCount : null);
    })();
    return () => { cancelled = true; };
  }, [api, clientId]);

  if (failed) {
    return (
      <PageContainer className="max-w-lg py-16 items-center text-center gap-4">
        <h1 className="text-lg font-bold text-foreground">This client is not available</h1>
        <Button variant="outline" className="gap-2" onClick={() => router.push(`${prefix}/clients`)}><ArrowLeft size={14} /> Back to clients</Button>
      </PageContainer>
    );
  }
  if (!client) return <PageContainer><Skeleton className="h-40 rounded-xl" /></PageContainer>;

  return (
    <SubCategoryWorkspace
      moduleKey={CLIENT_MODULE_BY_TYPE[client.clientType]}
      documentKey={documentKey}
      backHref={`${prefix}/clients/${clientId}`}
      backLabel={client.displayName}
      addBlockedMessage={configured === 0
        ? 'Choose the document types you keep for these clients first (Client Documents → Configure subcategories) — then you can add documents.'
        : undefined}
    />
  );
}
