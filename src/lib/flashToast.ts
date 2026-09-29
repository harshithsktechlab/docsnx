/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A message for the page you are ABOUT to be on                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `<Toaster />` is mounted once at the root (src/app/layout.js) and survives
 * client navigation, so a `toast()` fired immediately before `router.push()`
 * lands on the NEXT screen — by accident of timing, and for whatever is left of
 * its duration. That is how a sign-up ended with four messages stacked at the
 * top right, each one raised by a page the reader had already left:
 * "Registration successful…" read on /verify-email, "Account verified…" read
 * during the instant /dashboard existed, "Welcome to DocsNX!" read on the
 * dashboard after the wizard pushed it.
 *
 * So the rule is: anything said ABOUT a destination is handed to the
 * destination. This is that hand-off — one slot in `sessionStorage`, written
 * before the push and popped on arrival.
 *
 * ── WHY ONE SLOT ──────────────────────────────────────────────────────────
 * Because the last writer is the one that knows where the user is really
 * going. /verify-email pushes to /dashboard; Shell's gate then redirects an
 * unfinished workspace to /onboarding. Two messages, one arrival — and the
 * gate, writing last, wins the slot. A queue would deliver both.
 *
 * ── WHY NOT THE QUERY STRING ──────────────────────────────────────────────
 * `?google=<status>` (src/lib/googleConnectResults.ts) is the right shape when
 * the sender is a redirect flow and the messages are a closed set. These are
 * neither: /api/auth/register composes its sentence from the channels that
 * ACTUALLY accepted the send, which would need a status code per outcome and
 * would put it in the URL.
 */

export type FlashType = 'success' | 'error' | 'info' | 'warning';

export interface Flash {
  message: string;
  type: FlashType;
  /**
   * Pop only on this pathname. Set it whenever the destination is known, which
   * is what keeps a message pinned to /onboarding from being consumed by the
   * /dashboard render it passes through on the way. Leave it off when the
   * gates may divert the navigation — an unpinned flash pops on whatever
   * arrival comes first.
   */
  pin?: string;
  /**
   * What this flash is ABOUT. Read by whoever writes next: Shell's onboarding
   * gate looks for `verified` so it can greet a just-verified admin with one
   * sentence instead of overwriting theirs with a colder one. Doubles as the
   * sonner toast id, so a re-fire replaces rather than stacks.
   */
  tag?: string;
  duration?: number;
  /** Stamped by `setFlash`. See `MAX_AGE_MS`. */
  at: number;
}

const KEY = 'docsnx_flash';

/**
 * A flash is a hand-off between two pages, so it is stale the moment that
 * navigation does not happen — a push refused by a gate, a form abandoned, a
 * tab left open. Without this it would surface on some unrelated page an hour
 * later, which is the same defect in slower motion.
 */
const MAX_AGE_MS = 60_000;

/**
 * `sessionStorage` throws outright in Safari's private mode and wherever site
 * data is blocked — the same reason usePWA.js and storageToast.js guard every
 * access. A message not shown is an acceptable failure here; a thrown one in
 * the middle of a sign-up is not.
 */
function read(): Flash | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const flash = JSON.parse(raw) as Flash;
    if (!flash?.message || typeof flash.at !== 'number') return null;
    if (Date.now() - flash.at > MAX_AGE_MS) {
      clearFlash();
      return null;
    }
    return flash;
  } catch {
    return null;
  }
}

/** Hand a message to the next page. Overwrites whatever was pending. */
export function setFlash(flash: Omit<Flash, 'at'>): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...flash, at: Date.now() }));
  } catch {
    // Private mode / blocked site data. The navigation still happens.
  }
}

/** What is pending, without consuming it — for a writer deciding what to say. */
export function peekFlash(): Flash | null {
  return read();
}

/**
 * Take the message for this arrival, if this is the arrival it was meant for.
 *
 * Read-and-clear in one call, which is what makes it safe under React's
 * double-invoked effects in development: the second run finds an empty slot.
 */
export function popFlash(pathname: string): Flash | null {
  const flash = read();
  if (!flash) return null;
  if (flash.pin && flash.pin !== pathname) return null;
  clearFlash();
  return flash;
}

export function clearFlash(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // See `read`.
  }
}
