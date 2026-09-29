/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   `?render=1` — what "view" is supposed to mean                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The vault accepts eighteen file types and a browser draws six. For the other
 * twelve the preview said "No preview available — Download File", and the
 * download button is gated on `share`, so a member granted View and nothing
 * else could neither read their own .docx nor take it away. `render=1` asks the
 * route for a form the browser CAN draw.
 *
 * Which makes the gate the thing to pin down. Rendering to look at is not
 * taking a copy out, so it rides on `view` like any other read — the moment it
 * is confused with `share` it re-creates exactly the dead end it exists to fix.
 * And it must never come back as an attachment: a preview that downloads is not
 * a preview.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const row = {
  id: 'doc-1',
  fileName: 'agreement.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  filePath: '/api/records/rentals/doc-1/file',
  categoryModuleKey: 'rentals_subscriptions',
  categoryDocumentKey: 'rental_agreements',
  fileDriveId: 'drive-1',
};

const selectChain = {
  select: () => ({ from: () => ({ where: () => ({ limit: () => [row] }) }) }),
};
vi.mock('@/lib/db', () => ({
  db: selectChain,
  withTenant: async (_t: string, cb: any) => cb(selectChain),
}));

const hasPermission = vi.fn(async () => true);
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({
    id: 'u1', tenantId: 't1', role: 'STANDARD', tenant: { id: 't1' },
  })),
  hasPermission: (...a: any[]) => hasPermission(...(a as [])),
  // Every row in this file is personal, so the route's company gate is
  // never reached — mocked all the same, because a mock that omits an
  // export fails as "not a function" the moment someone adds a company
  // row here, which reads like a bug in the route.
  hasCompanyAccess: vi.fn(async () => true),
}));
const readRecord = vi.fn();
vi.mock('@/lib/vault/vaultRecords', () => ({
  readRecord: (...a: any[]) => readRecord(...a),
}));
const openDocumentFile = vi.fn();
vi.mock('@/lib/vault/vaultFiles', () => ({
  openDocumentFile: (...a: any[]) => openDocumentFile(...a),
}));

const renderForPreview = vi.fn();
vi.mock('@/lib/records/previewRender', async (orig) => {
  const actual = await (orig() as Promise<any>);
  return { ...actual, renderForPreview: (...a: any[]) => renderForPreview(...a) };
});

const { GET } = await import('@/app/api/records/[module]/[id]/file/route');

const params = { params: Promise.resolve({ module: 'rentals', id: 'doc-1' }) };
const get = (query = '') =>
  GET(new Request(`http://localhost/api/records/rentals/doc-1/file${query}`), params);

/** Which permission was asked for, across every hasPermission call. */
const askedFor = () => hasPermission.mock.calls.map((c: any[]) => c[2]);

beforeEach(() => {
  vi.clearAllMocks();
  hasPermission.mockResolvedValue(true);
  // The default shape: one stored page, which is how a .docx is held.
  readRecord.mockResolvedValue({
    pages: [{ page: 1, fileId: 'page-1', driveFileId: 'drive-1', mimeType: row.mimeType }],
  });
  openDocumentFile.mockResolvedValue(Buffer.from('sealed-docx-bytes'));
  renderForPreview.mockReturnValue({
    ok: true, bytes: Buffer.from('%PDF-1.4 rendered'), mimeType: 'application/pdf',
  });
});

describe('?render=1', () => {
  it('rides on `view` and never asks for `share`', async () => {
    const res = await get('?render=1');

    expect(res.status).toBe(200);
    expect(askedFor()).toEqual(['view']);
  });

  it('serves the RENDERED bytes and the rendered content type', async () => {
    const res = await get('?render=1');

    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(await res.text()).toBe('%PDF-1.4 rendered');
  });

  it('never pushes the preview at the user as a download', async () => {
    const res = await get('?render=1');

    expect(res.headers.get('Content-Disposition')).toBeNull();
    // The hardening the raw path carries is not traded away for the rendering.
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('classifies from the PAGE mime, not the record column', async () => {
    // These agree here; what is asserted is which one is passed, because they
    // disagree for every split PDF in the vault — JPEG pages under an
    // application/pdf record.
    await get('?render=1');

    expect(renderForPreview).toHaveBeenCalledWith(
      expect.any(Buffer), row.mimeType, 'agreement.docx', expect.anything(),
    );
  });

  it('answers 415 with a reason when nothing can render it', async () => {
    renderForPreview.mockReturnValue({ ok: false, reason: 'unsupported' });

    const res = await get('?render=1');

    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.status).toBe('PREVIEW_UNSUPPORTED');
    expect(body.reason).toBe('unsupported');
    // A reason worth putting in front of the person looking at it.
    expect(body.message).toMatch(/viewer|download/i);
  });

  it('is not reached by a plain read', async () => {
    const res = await get();

    expect(renderForPreview).not.toHaveBeenCalled();
    expect(res.headers.get('Content-Type')).toBe(row.mimeType);
  });

  it('yields to ?download=1, which still costs `share`', async () => {
    // A saved copy is the original file, not a rendering of it.
    const res = await get('?download=1&render=1');

    expect(renderForPreview).not.toHaveBeenCalled();
    expect(askedFor()).toContain('share');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
  });

  it('is refused with the record itself when `view` is denied', async () => {
    hasPermission.mockResolvedValue(false);

    const res = await get('?render=1');

    // 404, not 403: whether the record exists is withheld from a denied member.
    expect(res.status).toBe(404);
    expect(renderForPreview).not.toHaveBeenCalled();
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   `&as=image`, AND WHAT `?page=N` MEANS                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The vault holds two shapes and they disagree about what a page is:
 *
 *  · SPLIT — a scan rasterised at upload, one Drive object per sheet. Page N is
 *    Drive object N.
 *  · UNSPLIT — one PDF stored whole. The vault records ONE page however many
 *    sheets are inside, so asking for page 3 used to 404 on a perfectly good
 *    ten-page agreement and the pager never appeared at all.
 *
 * Getting this backwards is silent in both directions: an off-by-one store
 * lookup serves the wrong sheet, and a 404 on a readable document reads as data
 * loss. Both shapes are pinned here.
 */
describe('&as=image', () => {
  beforeEach(() => {
    renderForPreview.mockReturnValue({
      ok: true, bytes: Buffer.from('jpeg-bytes'), mimeType: 'image/jpeg', pageCount: 7,
    });
  });

  it('still rides on `view` alone', async () => {
    const res = await get('?render=1&as=image');

    expect(res.status).toBe(200);
    expect(askedFor()).toEqual(['view']);
  });

  it('asks the renderer for an image and serves what came back', async () => {
    const res = await get('?render=1&as=image');

    expect(renderForPreview).toHaveBeenCalledWith(
      expect.any(Buffer), row.mimeType, 'agreement.docx',
      expect.objectContaining({ asImage: true }),
    );
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('is not requested by `render=1` on its own', async () => {
    await get('?render=1');

    expect(renderForPreview).toHaveBeenCalledWith(
      expect.any(Buffer), row.mimeType, 'agreement.docx',
      expect.objectContaining({ asImage: false }),
    );
  });
});

describe('a PDF stored WHOLE — one vault page, many sheets', () => {
  beforeEach(() => {
    // One stored page. Whatever the pager asks for lives inside it.
    readRecord.mockResolvedValue({
      pages: [{ page: 1, fileId: 'page-1', driveFileId: 'drive-1', mimeType: 'application/pdf' }],
    });
    renderForPreview.mockReturnValue({
      ok: true, bytes: Buffer.from('sheet'), mimeType: 'image/jpeg', pageCount: 10,
    });
  });

  it('reads page 3 from INSIDE the document rather than 404ing', async () => {
    const res = await get('?render=1&as=image&page=3');

    expect(res.status).toBe(200);
    expect(renderForPreview).toHaveBeenCalledWith(
      expect.any(Buffer), 'application/pdf', 'agreement.docx',
      { asImage: true, page: 3 },
    );
  });

  it('reports the rendered count, which is the only true one', async () => {
    const res = await get('?render=1&as=image&page=3');

    // The record says one page. The document has ten, and the pager needs to
    // hear the second number or nine sheets stay unreachable.
    expect(res.headers.get('X-Preview-Page-Count')).toBe('10');
  });
});

describe('a scan stored SPLIT — one Drive object per sheet', () => {
  beforeEach(() => {
    readRecord.mockResolvedValue({
      pages: [
        { page: 1, fileId: 'page-1', driveFileId: 'drive-1', mimeType: 'image/jpeg' },
        { page: 2, fileId: 'page-2', driveFileId: 'drive-2', mimeType: 'image/jpeg' },
        { page: 3, fileId: 'page-3', driveFileId: 'drive-3', mimeType: 'image/jpeg' },
      ],
    });
    renderForPreview.mockReturnValue({
      ok: true, bytes: Buffer.from('sheet'), mimeType: 'image/jpeg',
    });
  });

  it('opens the page’s OWN Drive object, sealed under its own fileId', async () => {
    await get('?render=1&as=image&page=2');

    // The fileId is part of that page's AAD — page one's id on page two's
    // ciphertext fails its integrity check rather than returning wrong bytes.
    expect(openDocumentFile).toHaveBeenCalledWith(
      expect.objectContaining({ driveFileId: 'drive-2', fileId: 'page-2' }),
    );
  });

  it('does not then look for a page inside that sheet', async () => {
    await get('?render=1&as=image&page=2');

    // Each stored object is one sheet already; asking the rasteriser for its
    // page 2 would come back empty.
    expect(renderForPreview).toHaveBeenCalledWith(
      expect.any(Buffer), 'image/jpeg', 'agreement.docx',
      { asImage: true, page: 1 },
    );
  });

  it('reports the stored count, and still 404s past the end', async () => {
    const ok = await get('?render=1&as=image&page=3');
    expect(ok.headers.get('X-Preview-Page-Count')).toBe('3');

    const past = await get('?render=1&as=image&page=4');
    expect(past.status).toBe(404);
  });
});
