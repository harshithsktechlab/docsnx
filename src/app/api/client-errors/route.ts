export const dynamic = 'force-dynamic';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHY A CLIENT FAILURE HAS TO LEAVE A TRACE                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * An upload that dies in the browser reaches nginx as nothing at all: no
 * request line, no status, no entry in any log on this box. When a user
 * reported "Power Scan does not work on my phone", the entire evidence base was
 * a screenshot of a toast — and the toast said the same sentence for four
 * unrelated causes. Diagnosing it cost a deploy, and the deploy fixed the wrong
 * screen, because the message the user was actually seeing came from a
 * different page than the one in the screenshot.
 *
 * This endpoint exists so that never repeats. `postUpload`
 * (src/lib/records/uploadRequest.ts) and `apiRequest` (src/lib/net/apiRequest.ts)
 * post one small record of every failure they report to a user, and the answer
 * to "what is happening to her uploads?" becomes a grep instead of a
 * conversation.
 *
 * ── IT COVERS EVERY REQUEST NOW, NOT ONLY UPLOADS ──────────────────────────
 * Uploads were where the pain was loudest, but they are six screens out of
 * sixty-one. A list that will not load and a save that silently does nothing
 * generate exactly the same unanswerable support ticket, and left no trace
 * either. What did NOT change is the shape of what is accepted: closed enums,
 * numbers, one capped route string, and the rate limit below. The one addition
 * is `method`, itself an enum.
 *
 * Ordinary 4xx answers are filtered out on the CLIENT (see `reportClientFailure`)
 * rather than here: a 401 on a stale tab and a 403 from the permission matrix
 * are the system working, and at their volume they would bury the transport
 * failures this exists to surface.
 *
 * ── WHAT IT WILL NOT ACCEPT ────────────────────────────────────────────────
 * This is a vault. A diagnostic channel that logs whatever a client sends is a
 * way to write member data into a plaintext journal that survives on disk for
 * weeks, and every field below was chosen against that: causes and stages are
 * ENUMS, numbers are numbers, and the two free-text fields (`route`,
 * `userAgent`) are hard-capped and never sourced from a filename, a form value
 * or a record. There is deliberately no `message`, no `filename` and no
 * `detail` field — those are exactly where PII would arrive.
 *
 * ── AND WHY IT DOES NOT WRITE TO THE DATABASE ──────────────────────────────
 * A table would need a tenant column, an RLS policy, a migration, a retention
 * policy and a deletion path in account erasure — a real surface, for
 * throwaway telemetry. The journal already has rotation and already holds the
 * server half of every one of these stories, so the two halves sit together.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserFromRequest } from '@/lib/auth';

/**
 * Closed sets, not free text. Anything outside them is a client that has
 * drifted from `UploadOutcome`, and is worth a 400 rather than a log line
 * nobody can aggregate.
 */
const BodySchema = z.object({
  cause: z.enum(['offline', 'network', 'timeout', 'unreadable', 'http']),
  /**
   * Which verb failed. Added when this stopped being upload-only: a failing
   * GET on a list and a failing DELETE on the same route are different
   * incidents, and without this they are one indistinguishable log line.
   * An enum, like everything else here — never the raw header.
   */
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  stage: z.enum(['uploading', 'waiting']).optional(),
  status: z.number().int().min(0).max(599).optional(),
  sentBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  elapsedMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  wasHidden: z.boolean().optional(),
  // The endpoint that failed — one of ours, so it is bounded in practice and
  // capped here regardless.
  route: z.string().max(120),
}).strict();

/**
 * One report per user per ten seconds.
 *
 * A page that retries in a loop must not be able to fill the journal — the root
 * disk on this host runs close to full, and a log that fills it takes the app
 * down with it. In-memory and per-process, which is the right weight for
 * throwaway telemetry: a restart forgetting the window costs nothing.
 */
const RATE_LIMIT_MS = 10_000;
const lastReportAt = new Map<string, number>();

/** Keeps the map from growing without bound on a long-lived process. */
function sweep(now: number) {
  if (lastReportAt.size < 500) return;
  for (const [key, at] of lastReportAt) {
    if (now - at > RATE_LIMIT_MS) lastReportAt.delete(key);
  }
}

export async function POST(req: Request) {
  try {
    // Authenticated, so a report can be tied to a tenant when support asks —
    // and so this is not an open write into the host's logs.
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Validated BEFORE the rate limit, deliberately. Parsing costs nothing and
    // writes nothing, so a malformed client deserves the truthful 400 rather
    // than a 202 that hides its bug behind someone else's throttle. The limit
    // guards the only thing worth guarding — the write below.
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid report' }, { status: 400 });
    }
    const r = parsed.data;

    const now = Date.now();
    sweep(now);
    const previous = lastReportAt.get(user.id);
    if (previous && now - previous < RATE_LIMIT_MS) {
      // Accepted-and-dropped rather than 429: this is fire-and-forget from a
      // page that is already showing the user an error, and a failing beacon
      // must never become a second problem on that screen.
      return NextResponse.json({ success: true, recorded: false }, { status: 202 });
    }
    lastReportAt.set(user.id, now);

    // One line, greppable, with the two identifiers support actually needs and
    // nothing that could carry a member's data.
    console.error(
      `[client-request-failure] tenant=${user.tenantId} user=${user.id} `
      + `route=${r.route} cause=${r.cause}`
      + (r.method ? ` method=${r.method}` : '')
      + (r.stage ? ` stage=${r.stage}` : '')
      + (r.status !== undefined ? ` status=${r.status}` : '')
      + (r.elapsedMs !== undefined ? ` elapsedMs=${r.elapsedMs}` : '')
      + (r.totalBytes ? ` sent=${r.sentBytes ?? 0}/${r.totalBytes}` : '')
      + (r.wasHidden ? ' backgrounded=yes' : '')
      // Truncated hard: a UA string is client-controlled input on its way to a
      // log line, and this one is only here to tell iOS from Android.
      + ` ua="${(req.headers.get('user-agent') ?? '').slice(0, 160).replace(/["\r\n]/g, '')}"`,
    );

    return NextResponse.json({ success: true, recorded: true });
  } catch {
    // Never a 500 with a body: nothing on the client branches on this, and a
    // beacon that throws noisily is worse than one that quietly does nothing.
    return NextResponse.json({ success: false }, { status: 200 });
  }
}
