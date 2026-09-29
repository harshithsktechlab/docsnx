// @vitest-environment node
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/client-errors — telemetry that cannot become a data leak          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This endpoint exists because an upload that dies in the browser reaches the
 * server as nothing at all — no request line, no status, no log entry. The
 * first round of this investigation cost a production deploy that fixed the
 * WRONG SCREEN, because the only evidence was a screenshot of a toast and the
 * toast said the same sentence for four unrelated causes.
 *
 * Which makes the second rule as important as the first: this is a vault, and a
 * diagnostic channel that logs whatever a client sends is a way to write member
 * data into a plaintext journal that sits on disk for weeks. The assertions
 * below are that rule — the schema is `.strict()`, the free-text is capped, and
 * there is deliberately no field a filename or a form value could arrive in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let currentUser: any = { id: 'user-1', tenantId: 'tenant-1' };

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => currentUser),
}));

const { POST } = await import('@/app/api/client-errors/route');

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(new Request('https://docsnx.com/api/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
}

const VALID = { cause: 'network', stage: 'uploading', route: '/api/documents' };

let logged: string[] = [];
let errSpy: any;

beforeEach(() => {
  currentUser = { id: `user-${Math.random()}`, tenantId: 'tenant-1' };
  logged = [];
  errSpy = vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
    logged.push(args.join(' '));
  });
});
afterEach(() => errSpy.mockRestore());

describe('who may report', () => {
  it('refuses an anonymous caller — this writes to the host log', async () => {
    currentUser = null;
    expect((await post(VALID)).status).toBe(401);
    expect(logged).toHaveLength(0);
  });

  it('records an authenticated one, with the tenant for support to trace', async () => {
    const res = await post(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recorded: true });
    expect(logged[0]).toContain('tenant=tenant-1');
    expect(logged[0]).toContain('cause=network');
    expect(logged[0]).toContain('stage=uploading');
  });
});

describe('what it refuses to write down', () => {
  /**
   * The load-bearing assertion of this file. `.strict()` is what stops a
   * well-meaning future caller adding `filename` or `title` to the beacon
   * payload and quietly shipping vault contents into journalctl.
   */
  it('rejects ANY field not on the schema — filenames above all', async () => {
    for (const extra of [
      { filename: 'Aadhaar card - Archi.pdf' },
      { message: 'PAN ABCDE1234F did not upload' },
      { detail: 'account 50100234567890' },
    ]) {
      // A fresh user each time, or the rate limiter would answer instead of the
      // schema and this would pass for the wrong reason.
      currentUser = { id: `user-${Math.random()}`, tenantId: 'tenant-1' };
      const res = await post({ ...VALID, ...extra });
      expect(res.status).toBe(400);
    }
    expect(logged).toHaveLength(0);
  });

  it('accepts the cause the probe produces, so the next one is a grep', async () => {
    const res = await post({ cause: 'unreadable', route: '/api/documents', elapsedMs: 900 });
    expect(res.status).toBe(200);
    expect(logged[0]).toContain('cause=unreadable');
  });

  it('rejects a cause outside the known set', async () => {
    expect((await post({ ...VALID, cause: 'whatever' })).status).toBe(400);
  });

  it('caps the one free-text field', async () => {
    expect((await post({ ...VALID, route: 'x'.repeat(500) })).status).toBe(400);
  });

  it('truncates and de-quotes the user-agent it reads off the request', async () => {
    // Client-controlled input on its way to a log line. Newlines cannot arrive
    // through a real header at all — the platform rejects them — so what is
    // left to guard is length, and the quotes that would break the `ua="..."`
    // field for anything parsing these lines.
    await post(VALID, { 'user-agent': `"${'A'.repeat(400)}"` });
    const line = logged[0];
    expect(line.length).toBeLessThan(600);
    expect(line).toMatch(/ua="A+"$/);
  });
});

describe('it cannot fill the disk', () => {
  it('drops a second report from the same user inside the window', async () => {
    const first = await post(VALID);
    const second = await post(VALID);

    expect(first.status).toBe(200);
    // 202, not 429: this fires from a page already showing the user an error,
    // and a failing beacon must never become a second problem on that screen.
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ recorded: false });
    expect(logged).toHaveLength(1);
  });
});
