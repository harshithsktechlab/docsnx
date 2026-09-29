'use client';

/**
 * `/business/<companyId>/more` — one company's phone navigation.
 *
 * The SAME screen as `/more`, scoped by the company in the path: its modules
 * come from the business taxonomy and its Workspace links carry the company, so
 * the bottom nav's More tab no longer walks a phone user out of Acme and into
 * the household without saying so.
 *
 * Nothing here is a permission. The id in the URL is untrusted — see the
 * sibling `passwords/page.js` — and every page it links to re-proves access with
 * `hasCompanyAccess` on arrival.
 */
import { useParams } from 'next/navigation';
import MoreScreen from '@/app/components/MoreScreen';

export default function BusinessMorePage() {
  const { companyId } = useParams();
  return <MoreScreen companyId={companyId} />;
}
