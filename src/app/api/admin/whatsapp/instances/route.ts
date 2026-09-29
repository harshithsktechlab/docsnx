/**
 * The instances the Evolution engine currently holds, for the admin picker.
 *
 * Reads the STORED connection rather than accepting a URL and key in the
 * request, so a credential never travels in a body just to populate a dropdown.
 * The admin flow is therefore: enter URL + key → Save → Refresh → pick.
 *
 * Answers with a `reason` as well as the list. Four unrelated problems — never
 * configured, a key this server cannot decrypt, a key the engine rejects, and a
 * URL that reaches nothing — all end as an empty array, and a picker that
 * cannot tell them apart guesses wrong and sends the admin to the wrong screen.
 */
import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { fetchInstancesDetailed, type InstancesReason } from '@/lib/whatsapp';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/**
 * What to tell the admin, per reason.
 *
 * Carries status codes and fixed prose only — never the key, never the engine's
 * own auth response body.
 */
function explain(reason: InstancesReason, status?: number): string {
  switch (reason) {
    case 'ok':
      return '';
    case 'missing_url':
      return 'No Evolution API URL is saved yet. Enter the URL and key, then save.';
    case 'missing_key':
      return 'No Evolution API key is saved yet. Paste the key and save.';
    case 'key_unreadable':
      return 'A key is stored but this server cannot decrypt it (ENCRYPTION_SECRET mismatch). Paste the Evolution API key again and save.';
    case 'unauthorized':
      return 'The engine rejected the key. Use the global Evolution API key — an instance-scoped token only ever lists its own instance.';
    case 'http_error':
      return `The engine answered HTTP ${status ?? '???'}. Check the saved URL and the engine's logs.`;
    case 'unreachable':
      return 'Nothing answered at the saved URL. Check the scheme (http vs https), the host, and that the URL carries no extra path.';
    case 'bad_payload':
      return 'The engine answered with something other than a list of instances. Check that the URL points at Evolution API itself.';
    case 'empty':
      return 'The engine holds no instances. Link a phone in the Evolution dashboard first.';
  }
}

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    // `fetchInstancesDetailed` swallows its own failures and returns [] — an
    // engine that is down should empty the dropdown, not 500 the settings page.
    // `reason` is what tells the UI which failure it was.
    const { instances, reason, status } = await fetchInstancesDetailed();

    const unconfigured = reason === 'missing_url' || reason === 'missing_key';
    return NextResponse.json({
      success: true,
      // Kept for compatibility with the existing page; `reason` is the real answer.
      configured: !unconfigured,
      reachable: reason === 'ok' || reason === 'empty',
      reason,
      message: explain(reason, status),
      instances,
    });
  } catch (error) {
    return serverError(error, 'fetching WhatsApp instances');
  }
}
