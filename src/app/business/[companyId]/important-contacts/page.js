'use client';

/**
 * `/business/<companyId>/important-contacts` — one company's contacts.
 *
 * The SAME component as `/important-contacts`, scoped by the company in the
 * path. See the sibling `passwords/page.js` for why the id here is not a
 * permission.
 */
import ImportantContactsPage from '@/app/important-contacts/page';

export default function BusinessImportantContactsPage() {
  return <ImportantContactsPage />;
}
