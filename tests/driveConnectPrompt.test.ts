/**
 * Drive is optional at sign-up; the first write that needs it must raise the
 * "Connect Google Drive" prompt — and a read must not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiCall } from '@/lib/net/apiRequest';
import { onDriveConnectPrompt, promptIfDriveMissing } from '@/lib/driveConnectPrompt';

const BODY = { success: false, status: 'DRIVE_NOT_CONNECTED', error: 'Connect Google Drive to upload.' };

function response(status: number, body: unknown): any {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

let opened: ReturnType<typeof vi.fn<() => void>>;
let off: () => void;

beforeEach(() => {
  opened = vi.fn<() => void>();
  off = onDriveConnectPrompt(opened);
  vi.stubGlobal('fetch', vi.fn(async () => response(400, BODY)));
});
afterEach(() => {
  off();
  vi.unstubAllGlobals();
});

describe('promptIfDriveMissing', () => {
  it('opens for a failed write', () => {
    promptIfDriveMissing('POST', BODY);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('ignores reads, and other failures', () => {
    promptIfDriveMissing('GET', BODY);
    promptIfDriveMissing(undefined, BODY);
    promptIfDriveMissing('POST', { status: 'STORAGE_LIMIT_EXCEEDED' });
    promptIfDriveMissing('POST', null);
    expect(opened).not.toHaveBeenCalled();
  });
});

describe('apiCall', () => {
  it('opens the prompt when a save is refused for lack of Drive', async () => {
    const { json } = await apiCall('/api/passwords', { method: 'POST', body: '{}' });
    expect(json.status).toBe('DRIVE_NOT_CONNECTED'); // the caller still gets the body
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('does not open it for a read', async () => {
    await apiCall('/api/documents');
    expect(opened).not.toHaveBeenCalled();
  });
});
