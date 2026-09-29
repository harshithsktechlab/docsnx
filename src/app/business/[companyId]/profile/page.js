'use client';

/**
 * `/business/<companyId>/profile` — one company's profile.
 *
 * The SAME screen as `/profile`, scoped by the company in the path: it gains a
 * Company Profile tab beside the member's own details, so "Profile" inside Acme
 * answers both readings of the word.
 *
 * Nothing here is a permission. The id in the URL is untrusted — see the
 * sibling `passwords/page.js` — and /api/companies/<id>/profile re-proves both
 * the company (`hasCompanyAccess`) and the verb (`hasPermission`) on arrival.
 */
import { useParams } from 'next/navigation';
import ProfileScreen from '@/app/components/ProfileScreen';

export default function BusinessProfilePage() {
  const { companyId } = useParams();
  return <ProfileScreen companyId={companyId} />;
}
