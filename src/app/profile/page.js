'use client';

/**
 * `/profile` — the household's profile page.
 *
 * A thin wrapper since the company workspace gained one of its own: the screen
 * itself lives in `components/ProfileScreen.jsx` so both routes render the same
 * component, the way `/more` and `/business/<id>/more` already do.
 *
 * With no company it is exactly the page it has always been — My Profile, four
 * sections, no tab strip.
 */
import ProfileScreen from '@/app/components/ProfileScreen';

export default function ProfilePage() {
  return <ProfileScreen />;
}
