'use client';

/**
 * `/users` — the household's member list.
 *
 * A thin wrapper since the company workspace gained one of its own: the screen
 * lives in `components/MembersScreen.jsx` so both routes render the same
 * component, the way `/more` and `/profile` already do.
 *
 * With no company it lists the members added to the personal account, and the
 * Add-member dialog adds to that account.
 */
import MembersScreen from '@/app/components/MembersScreen';

export default function UsersPage() {
  return <MembersScreen />;
}
