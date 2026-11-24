'use client';

/**
 * `/business/<companyId>/clients` — Client Documents: the company's clients,
 * Individual and Company. The id in the URL is untrusted; every request re-proves it.
 */
import ClientsHome from '@/app/components/clients/ClientsHome';

export default function BusinessClientsPage() {
  return <ClientsHome />;
}
