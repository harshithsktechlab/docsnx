'use client';

/**
 * `/more` — the household's phone navigation.
 *
 * The screen itself is `MoreScreen`, shared with `/business/<id>/more`. It lives
 * in a component rather than here because the workspace is carried by the URL,
 * so a company needs a route of its own — this page is the personal half of
 * that pair, and passes no company.
 */
import MoreScreen from '@/app/components/MoreScreen';

export default function MorePage() {
  return <MoreScreen />;
}
