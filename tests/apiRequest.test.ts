/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE FIVE THINGS ONE `catch` USED TO FLATTEN                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * 253 call sites did `const json = await res.json()` inside a `try` and
 * answered every failure with one sentence. These assertions are the five
 * causes that sentence covered, each now distinguishable — plus the rule that
 * keeps the diagnostic beacon from becoming the noise it exists to cut through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiRequest, apiJson } from '@/lib/net/apiRequest';

/** A Response-alike; `apiRequest` only ever reads these four members. */
function response(status: number, body: string): any {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/** Rejects the way `fetch` does when its signal aborts, and never otherwise. */
function hangingFetch() {
  return (_url: string, init: any) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err: any = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Calls the beacon made, ignoring the request under test. */
function beacons() {
  return fetchMock.mock.calls.filter((c) => c[0] === '/api/client-errors');
}

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setOnline(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ───────────────────────────────────────────────────────────────────────────
describe('a body that is not JSON', () => {
  it('does not throw a SyntaxError into the caller', async () => {
    // The whole reason "your file is too large" was displayed as a network
    // error: nginx's 413 is an HTML page, `JSON.parse` throws on it, and the
    // throw landed in the catch block labelled "Network error".
    fetchMock.mockResolvedValueOnce(response(413, '<html>413 Request Entity Too Large</html>'));

    const outcome = await apiRequest('/api/documents', { method: 'POST' });

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ kind: 'http', status: 413, json: null });
  });

  it('reports a 2xx with an empty body as a success', async () => {
    fetchMock.mockResolvedValueOnce(response(204, ''));
    const outcome = await apiRequest('/api/records/medical/abc', { method: 'DELETE' });
    expect(outcome.ok).toBe(true);
  });

  it('reports a 2xx whose body is broken JSON as an http failure, not a success', async () => {
    fetchMock.mockResolvedValueOnce(response(200, '{"success": tru'));
    const outcome = await apiRequest('/api/medical');
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ kind: 'http', status: 200, json: null });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('offline is told apart from a dropped connection', () => {
  it('never attempts the request when the device is already offline', async () => {
    setOnline(false);
    const outcome = await apiRequest('/api/medical');

    expect(outcome).toEqual({ ok: false, kind: 'offline' });
    // Only the beacon; the request itself was never made.
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/medical')).toHaveLength(0);
  });

  it('re-asks at failure time, so going offline mid-request reads as offline', async () => {
    // The common case on a phone, and it deserves the clearer message.
    fetchMock.mockImplementationOnce(async () => {
      setOnline(false);
      throw new TypeError('Failed to fetch');
    });

    const outcome = await apiRequest('/api/medical');
    expect(outcome).toEqual({ ok: false, kind: 'offline' });
  });

  it('reports a genuine transport failure as network, not offline', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const outcome = await apiRequest('/api/medical');
    expect(outcome).toMatchObject({ kind: 'network', stage: 'waiting' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a request that never answers', () => {
  it('gives up and says so, rather than leaving a spinner forever', async () => {
    fetchMock.mockImplementationOnce(hangingFetch());
    const outcome = await apiRequest('/api/medical', { timeoutMs: 20 });
    expect(outcome).toMatchObject({ kind: 'timeout', stage: 'waiting' });
  });

  it('does not mistake the caller cancelling for a timeout', async () => {
    // A superseded search keystroke. Not a failure, and it must not toast.
    fetchMock.mockImplementationOnce(hangingFetch());
    const controller = new AbortController();
    const pending = apiRequest('/api/search?q=a', { signal: controller.signal });
    controller.abort();

    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'http', status: 0 });
    expect(beacons()).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the diagnostic beacon', () => {
  it('reports a transport failure exactly once', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await apiRequest('/api/medical');
    expect(beacons()).toHaveLength(1);
  });

  it('strips record ids out of the route before sending it', async () => {
    // The endpoint refuses free text precisely so member data cannot reach a
    // plaintext journal; a uuid in the path IS a record identifier.
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await apiRequest('/api/medical/3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071?full=1', { method: 'DELETE' });

    const body = JSON.parse(beacons()[0][1].body);
    expect(body.route).toBe('/api/medical/:id');
    expect(body.method).toBe('DELETE');
  });

  it('stays silent for the ordinary 4xx answers, which are the system working', async () => {
    // A 401 on a stale tab and a 403 from the permission matrix would bury the
    // transport failures this exists to surface, at many times their volume.
    for (const status of [400, 401, 403, 404, 409]) {
      fetchMock.mockResolvedValueOnce(response(status, '{"error":"no"}'));
      await apiRequest('/api/medical');
    }
    expect(beacons()).toHaveLength(0);
  });

  it('does report the ones that mean something is wrong at our end', async () => {
    for (const status of [429, 500, 502, 507]) {
      fetchMock.mockResolvedValueOnce(response(status, '{}'));
      await apiRequest('/api/medical');
    }
    expect(beacons()).toHaveLength(4);
  });

  it('never lets a failing beacon become a second failure on screen', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));   // the request
    fetchMock.mockRejectedValueOnce(new Error('beacon is down too'));    // the beacon
    await expect(apiRequest('/api/medical')).resolves.toMatchObject({ kind: 'network' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('apiJson', () => {
  it('sets the Content-Type no call site should have to remember', async () => {
    fetchMock.mockResolvedValueOnce(response(200, '{"success":true}'));
    await apiJson('/api/passwords', 'POST', { title: 'x' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"title":"x"}');
    expect(init.method).toBe('POST');
  });

  it('sends no body when there is none, rather than "undefined"', async () => {
    fetchMock.mockResolvedValueOnce(response(200, '{"success":true}'));
    await apiJson('/api/passwords/abc', 'DELETE');
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });
});
