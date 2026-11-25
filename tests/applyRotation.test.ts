import { describe, expect, it, vi } from 'vitest';
import { applyRotation } from '@/lib/records/applyRotation';

const ok = (json: any) => ({ ok: true, status: 200, json });
const fail = (status: number, json: any = {}) => ({ ok: false, status, json });

describe('applyRotation', () => {
  it('rewrites the file and reports the new size', async () => {
    const request = vi.fn(async () => ok({ success: true, rotation: 0, fileSize: 1234 }));
    const out = await applyRotation(request, 'doc1', 90);
    expect(out).toEqual({ mode: 'file', rotation: 0, fileSize: 1234 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual(['/api/documents/doc1/rotation/apply', expect.objectContaining({ method: 'POST', body: '{"degrees":90}' })]);
  });

  it('falls back to the display preference on a 415', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(fail(415, { code: 'ROTATION_UNSUPPORTED' }))
      .mockResolvedValueOnce(ok({ success: true, rotation: 270 }));
    const out = await applyRotation(request, 'doc1', 270);
    expect(out).toEqual({ mode: 'view', rotation: 270 });
    expect(request.mock.calls[1][0]).toBe('/api/documents/doc1/rotation');
    expect(request.mock.calls[1][1].method).toBe('PUT');
  });

  it('throws the server message on any other failure, without touching the preference', async () => {
    const request = vi.fn(async () => fail(403, { error: 'Forbidden' }));
    await expect(applyRotation(request, 'doc1', 90)).rejects.toThrow('Forbidden');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('clears the preference only when turned back to upright', async () => {
    const request = vi.fn(async () => ok({ success: true, rotation: 0 }));
    const out = await applyRotation(request, 'doc1', 360);
    expect(out).toEqual({ mode: 'view', rotation: 0 });
    expect(request.mock.calls[0][0]).toBe('/api/documents/doc1/rotation');
  });
});
