/**
 * DEPRECATED — this endpoint is now /api/members.
 *
 * It only still exists because docsnx is a PWA: a client whose service worker
 * is holding the pre-rename bundle keeps calling this path until its next
 * update, and a 404 here empties every "Belongs to" picker in the app — the
 * exact bug /api/members was created to fix.
 *
 * Delegates rather than re-exports so there is one handler, not two, and so
 * Next's route-type generation sees a plain exported GET.
 *
 * Remove this folder one release after the members rename ships.
 */
import { GET as membersGet } from '../members/route';

export async function GET(req: Request) {
  return membersGet(req);
}
