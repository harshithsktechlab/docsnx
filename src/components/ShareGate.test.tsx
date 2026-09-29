import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ShareGate from '@/components/ShareGate';
import { shareRecords } from '@/lib/sharePrintHelper';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE REPORTED BUG, END TO END                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * "Share works sometimes, and otherwise says the details were copied." The
 * cause: fetching the document spends the transient user activation
 * `navigator.share()` needs, so a slow PDF came back `NotAllowedError` and fell
 * all the way through to the clipboard.
 *
 * These drive the whole path — `shareRecords` → the failure → the gate → the
 * user's tap — against a real mounted `ShareGate`, rather than testing the
 * pieces separately and assuming they meet.
 */

const RECORD = {
  id: 'rec-1',
  title: 'Passport',
  fields: [{ label: 'Number', value: 'X1234567' }],
  filePath: '/api/records/documents/rec-1/file',
  fileName: 'passport',
  mimeType: 'application/pdf',
  pageCount: 1,
};

function activationExpired() {
  const err = new Error('user activation required');
  err.name = 'NotAllowedError';
  return err;
}

let share: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  share = vi.fn().mockResolvedValue(undefined);
  writeText = vi.fn().mockResolvedValue(undefined);

  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/pdf' },
    blob: async () => new Blob(['bytes'], { type: 'application/pdf' }),
  })));
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ShareGate', () => {
  it('renders nothing while no share needs it', () => {
    const { container } = render(<ShareGate />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays out of the way when the share succeeds first time', async () => {
    render(<ShareGate />);

    const result = await shareRecords([RECORD]);

    expect(result).toMatchObject({ success: true, method: 'share-files' });
    expect(screen.queryByText(/Ready to share/)).toBeNull();
  });

  it('opens when the activation expired, and shares on the tap', async () => {
    share.mockRejectedValueOnce(activationExpired());
    render(<ShareGate />);

    const pending = shareRecords([RECORD]);

    fireEvent.click(await screen.findByRole('button', { name: /^Share$/ }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
    // The retry sends the SAME bytes — the gate exists to avoid a second
    // decrypt, not just to ask again.
    expect((share.mock.calls[1][0] as any).files[0].name).toBe('passport.pdf');
    await expect(pending).resolves.toMatchObject({ success: true, method: 'share-files' });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports a dismissed dialog without copying anything', async () => {
    share.mockRejectedValueOnce(activationExpired());
    render(<ShareGate />);

    const pending = shareRecords([RECORD]);
    await screen.findByRole('button', { name: /^Share$/ });

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });

    await expect(pending).resolves.toMatchObject({ success: false, reason: 'dismissed' });
    // The bug this guards: walking away from a share must not put the record's
    // details on the clipboard behind the user's back.
    expect(writeText).not.toHaveBeenCalled();
  });

  it('offers saving and copying — not sharing — where the browser has no sheet', async () => {
    // Firefox on the desktop, Chrome on Linux.
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    render(<ShareGate />);

    const pending = shareRecords([RECORD]);

    expect(await screen.findByText(/Sharing is not available in this browser/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Share$/ })).toBeNull();
    // The document was still fetched, so saving it is offerable. Skipping that
    // fetch left a Firefox user "copy the details" as their entire answer for a
    // record whose whole point is the attachment.
    expect(screen.getByRole('button', { name: /Save file/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Copy details/ }));

    await expect(pending).resolves.toMatchObject({ success: true, method: 'copy' });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Passport'));
  });
});
