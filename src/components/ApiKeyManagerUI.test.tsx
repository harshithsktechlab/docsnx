/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE SCREEN THAT DIAGNOSES AI FAILURES, DIAGNOSING ITS OWN              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Rewritten alongside the component, because what it asserted stopped being
 * true in two directions:
 *
 *   · Two handlers reported NOTHING on failure. The old suite pinned that down
 *     — "does nothing if handleDelete response is not ok" — as if silence were
 *     the specification. It was a bug: the row did not change, no message
 *     appeared, and the admin pressed the button again.
 *   · The mocks answered `res.json()`. The component now goes through
 *     `apiRequest`, which reads a body ONCE as text and parses it in a `try`,
 *     because nginx's 413 and 502 pages are HTML and `res.json()` threw a
 *     SyntaxError on them that the app reported as a network failure. A double
 *     that only implements `json()` is no longer modelling a Response.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ApiKeyManagerUI from './ApiKeyManagerUI';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const ok = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const fail = (status: number, body: unknown = {}) =>
  ({ ok: false, status, text: async () => JSON.stringify(body) });
/** What a reverse proxy actually answers with. Not JSON, and not parseable. */
const proxyPage = (status: number) =>
  ({ ok: false, status, text: async () => `<html><body>${status}</body></html>` });

const ONE_KEY = {
  keys: [{
    id: '1', key: 'AIzaSy1234567890', name: 'Test Key',
    provider: 'GEMINI', isActive: true, usageCount: 5,
  }],
};

/** Renders with a key already listed, ready for a row action. */
async function renderWithKey() {
  mockFetch.mockResolvedValueOnce(ok(ONE_KEY));
  render(<ApiKeyManagerUI />);
  await waitFor(() => screen.getByText('Test Key'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue(ok({ keys: [] }));
  global.confirm = vi.fn(() => true);
});

// ───────────────────────────────────────────────────────────────────────────
describe('listing keys', () => {
  it('renders the empty state once loaded', async () => {
    render(<ApiKeyManagerUI />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('AI API Keys')).toBeInTheDocument());
    expect(screen.getByText('No API keys added yet.')).toBeInTheDocument();
  });

  it('renders the keys it was given', async () => {
    await renderWithKey();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('GEMINI')).toBeInTheDocument();
  });

  it('says the session expired rather than "Failed to fetch keys"', async () => {
    // A super-admin tab left open overnight. The old message sent them looking
    // for a problem with the keys.
    mockFetch.mockResolvedValueOnce(fail(401));
    render(<ApiKeyManagerUI />);
    await waitFor(() => expect(screen.getByText(/session has expired/i)).toBeInTheDocument());
  });

  it('does not read a proxy HTML page as a problem with the connection', async () => {
    mockFetch.mockResolvedValueOnce(proxyPage(502));
    render(<ApiKeyManagerUI />);
    await waitFor(() => expect(screen.getByText(/server took too long/i)).toBeInTheDocument());
    expect(screen.queryByText(/offline|wi-?fi/i)).not.toBeInTheDocument();
  });

  it('reports a dropped connection without claiming anything was changed', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<ApiKeyManagerUI />);
    await waitFor(() => expect(screen.getByText(/connection dropped/i)).toBeInTheDocument());
    // A GET changes nothing, so it must not tell anyone to go and check.
    expect(screen.queryByText(/may have completed|check the list/i)).not.toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('adding a key', () => {
  async function submitKey(value = 'AIzaSyNEW') {
    render(<ApiKeyManagerUI />);
    await waitFor(() => screen.getByText('AI API Keys'));
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('AIzaSy...'), { target: { value } });
      fireEvent.click(screen.getByText('Add Key'));
    });
  }

  it('adds the key and reloads the list', async () => {
    mockFetch.mockResolvedValueOnce(ok({ keys: [] }));           // initial load
    mockFetch.mockResolvedValueOnce(ok({ success: true }));       // the POST
    mockFetch.mockResolvedValueOnce(ok({                          // the reload
      keys: [{ id: '2', key: 'AIzaSyNEW0000', name: 'New Key', provider: 'GEMINI', isActive: true, usageCount: 0 }],
    }));
    await submitKey();
    await waitFor(() => expect(screen.getByText('New Key')).toBeInTheDocument());
  });

  it('shows what the route said when it refused the key', async () => {
    mockFetch.mockResolvedValueOnce(ok({ keys: [] }));
    mockFetch.mockResolvedValueOnce(fail(400, { error: 'Invalid key' }));
    await submitKey('bad-key');
    await waitFor(() => expect(screen.getByText('Invalid key')).toBeInTheDocument());
  });

  it('falls back to its own sentence only when the route sent none', async () => {
    mockFetch.mockResolvedValueOnce(ok({ keys: [] }));
    mockFetch.mockResolvedValueOnce(fail(400, {}));
    await submitKey('bad-key');
    // `apiCall` fills `error` in, so this is the platform's sentence rather
    // than the component's — but either way it is not "Network error".
    await waitFor(() => expect(screen.queryByText(/network error/i)).not.toBeInTheDocument());
    expect(screen.getByText(/refused|could not/i)).toBeInTheDocument();
  });

  it('does not submit an empty key', async () => {
    render(<ApiKeyManagerUI />);
    await waitFor(() => screen.getByText('AI API Keys'));
    mockFetch.mockClear();
    await act(async () => { fireEvent.click(screen.getByText('Add Key')); });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the two handlers that used to fail in silence', () => {
  it('says why a delete did not happen, instead of leaving the row there', async () => {
    // Previously: `if (res.ok) fetchKeys()` with no else. The key stayed on
    // screen, nothing was said, and the admin pressed Delete again.
    await renderWithKey();
    mockFetch.mockResolvedValueOnce(fail(403, { error: 'Only a super admin may delete keys.' }));
    await act(async () => { fireEvent.click(screen.getByTitle('Delete Key')); });
    await waitFor(() =>
      expect(screen.getByText('Only a super admin may delete keys.')).toBeInTheDocument());
    expect(screen.getByText('Test Key')).toBeInTheDocument();
  });

  it('says why a toggle did not take effect', async () => {
    await renderWithKey();
    mockFetch.mockResolvedValueOnce(fail(500, { error: 'Could not update the key.', reference: 'K3P9QZ' }));
    await act(async () => { fireEvent.click(screen.getByText('Deactivate')); });
    await waitFor(() => expect(screen.getByText('Could not update the key.')).toBeInTheDocument());
  });

  it('still asks before deleting, and does nothing when refused', async () => {
    global.confirm = vi.fn(() => false);
    await renderWithKey();
    mockFetch.mockClear();
    await act(async () => { fireEvent.click(screen.getByTitle('Delete Key')); });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('deletes and reloads on success', async () => {
    await renderWithKey();
    mockFetch.mockResolvedValueOnce(ok({ success: true }));
    mockFetch.mockResolvedValueOnce(ok({ keys: [] }));
    await act(async () => { fireEvent.click(screen.getByTitle('Delete Key')); });
    await waitFor(() => expect(screen.getByText('No API keys added yet.')).toBeInTheDocument());
  });

  it('toggles and reloads on success', async () => {
    await renderWithKey();
    mockFetch.mockResolvedValueOnce(ok({ success: true }));
    mockFetch.mockResolvedValueOnce(ok({
      keys: [{ ...ONE_KEY.keys[0], isActive: false }],
    }));
    await act(async () => { fireEvent.click(screen.getByText('Deactivate')); });
    await waitFor(() => expect(screen.getByText('Activate')).toBeInTheDocument());
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the health check', () => {
  it('reports a healthy key', async () => {
    await renderWithKey();
    mockFetch.mockResolvedValueOnce(ok({ success: true, health: { valid: true } }));
    await act(async () => { fireEvent.click(screen.getByText('Health')); });
    await waitFor(() => expect(screen.getByText('Healthy')).toBeInTheDocument());
  });

  it('reports the provider’s own reason for an invalid key', async () => {
    await renderWithKey();
    mockFetch.mockResolvedValueOnce(
      ok({ success: true, health: { valid: false, reason: 'Rate limit exceeded' } }));
    await act(async () => { fireEvent.click(screen.getByText('Health')); });
    await waitFor(() =>
      expect(screen.getByText('Invalid: Rate limit exceeded')).toBeInTheDocument());
  });

  it('distinguishes "the check did not run" from "the key is bad"', async () => {
    // Both used to read `Invalid: Network Error`, which accuses the key of a
    // fault when the request never reached the route at all.
    await renderWithKey();
    mockFetch.mockResolvedValueOnce(fail(401));
    await act(async () => { fireEvent.click(screen.getByText('Health')); });
    await waitFor(() => expect(screen.getByText(/session has expired/i)).toBeInTheDocument());
    expect(screen.queryByText(/Network Error/)).not.toBeInTheDocument();
  });

  it('reports a 200 that says the check itself failed', async () => {
    await renderWithKey();
    mockFetch.mockResolvedValueOnce(ok({ success: false, error: 'Failed to check health' }));
    await act(async () => { fireEvent.click(screen.getByText('Health')); });
    await waitFor(() =>
      expect(screen.getByText('Invalid: Failed to check health')).toBeInTheDocument());
  });
});
