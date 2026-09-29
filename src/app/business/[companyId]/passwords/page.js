'use client';

/**
 * `/business/<companyId>/passwords` — one company's credential vault.
 *
 * The SAME component as `/passwords`; only the URL differs. It reads the company
 * off `useParams` through `useWorkspaceApi`, so every request it makes carries
 * `?companyId=` and the route answers with that company's rows — a separate
 * sealed store from the household's, under a different AAD.
 *
 * Nothing here is a permission: the id in the URL is untrusted, and every
 * request it produces is re-proven server-side by `hasCompanyAccess`.
 */
import PasswordsPage from '@/app/passwords/page';

export default function BusinessPasswordsPage() {
  return <PasswordsPage />;
}
