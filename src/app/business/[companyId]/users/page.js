'use client';

/**
 * `/business/<companyId>/users` — one company's member list.
 *
 * The SAME screen as `/users`, scoped by the company in the path: it lists the
 * members granted this company and nobody else, and Add Member adds someone to
 * this company rather than asking which account they are for.
 *
 * Nothing here is a permission. The id in the URL is untrusted — see the
 * sibling `passwords/page.js` — and /api/users re-proves it with
 * `hasCompanyAccess` on top of its own TENANT_ADMIN gate.
 */
import { useParams } from 'next/navigation';
import MembersScreen from '@/app/components/MembersScreen';

export default function BusinessUsersPage() {
  const { companyId } = useParams();
  return <MembersScreen companyId={companyId} />;
}
