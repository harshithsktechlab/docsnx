'use client';

/**
 * `/business/<companyId>/documents` — one company's Document Manager.
 *
 * The SAME component as `/documents`; only the URL differs. It reads the company
 * off `useParams` through `useWorkspaceApi`, so every request it makes carries
 * `?companyId=` and the route answers with that company's rows — a separate
 * sealed store from the household's, under a different AAD. Its category filters
 * and upload picker follow the same axis, offering the fourteen `biz_*` modules
 * rather than Identity and Medical.
 *
 * Nothing here is a permission: the id in the URL is untrusted, and every
 * request it produces is re-proven server-side by `hasCompanyAccess` — see the
 * sibling `passwords/page.js`.
 */
import DocumentsPage from '@/app/documents/page';

export default function BusinessDocumentsPage() {
  return <DocumentsPage />;
}
