/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ONE PREVIEW PANE — every format, and the page you asked for       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two rules here are the whole reason twelve of the eighteen accepted file
 * types were unviewable, and both are easy to quietly undo:
 *
 *   · The renderer is chosen from the type the ROUTE SERVED, never from the
 *     record's `mimeType` column. The column is the original upload's type and
 *     is wrong about the bytes for half the vault — a split PDF is JPEG pages,
 *     a .docx fetched with `render=1` arrives as a PDF. Reading the column drew
 *     every one of those with the wrong element.
 *   · Text is rendered THROUGH REACT, never framed. A blob URL inherits this
 *     document's origin, so framing uploaded bytes is only ever safe for the
 *     narrow set the route promises.
 *
 * And the pager, because a ten-page scanned agreement that only ever showed its
 * first sheet is a document you cannot read.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchRecordBlob = vi.fn();
vi.mock('@/lib/sharePrintHelper', () => ({
  fetchRecordBlob: (...a: any[]) => fetchRecordBlob(...a),
  getFileUrl: (p: string) => p,
}));

/** Whether this "browser" has a PDF viewer. Every phone does not. */
const canDisplayPdf = vi.fn(() => true);
vi.mock('@/lib/records/inlineRender', async (orig) => {
  const actual = await (orig() as Promise<any>);
  return { ...actual, canDisplayPdf: () => canDisplayPdf() };
});

import FilePreviewPane from './FilePreviewPane';

const record = (over: Record<string, unknown> = {}) => ({
  kind: 'record' as const,
  filePath: '/api/records/documents/doc-1/file',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  name: 'Lease agreement',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  (URL as any).createObjectURL = vi.fn(() => 'blob:made');
  (URL as any).revokeObjectURL = vi.fn();
  canDisplayPdf.mockReturnValue(true);
  fetchRecordBlob.mockResolvedValue({ url: 'blob:made', mimeType: 'application/pdf' });
});

describe('what it asks the route for', () => {
  it('always asks for a renderable form', async () => {
    render(<FilePreviewPane source={record()} />);

    await waitFor(() => expect(fetchRecordBlob).toHaveBeenCalledWith(
      '/api/records/documents/doc-1/file',
      { page: 1, render: true, asImage: false },
    ));
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A PHONE CANNOT FRAME A PDF — so it must never be sent one              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * No mobile browser renders a PDF in an iframe. Android Chrome puts an "open /
 * download" bar there instead, and inside an installed PWA that bar leads
 * nowhere, because the frame's source is a `blob:` URL nothing is registered to
 * open. So every office document `render=1` converts to a PDF — the whole point
 * of the conversion — arrived on phones as an empty box.
 *
 * The rule this pins: where the browser says it has no viewer, ask for images.
 * An iframe rendered on such a client is the bug coming back.
 */
describe('a client with no PDF viewer', () => {
  beforeEach(() => {
    canDisplayPdf.mockReturnValue(false);
    fetchRecordBlob.mockResolvedValue({
      url: 'blob:made', mimeType: 'image/jpeg', pageCount: 4,
    });
  });

  it('asks the route to rasterise instead', async () => {
    render(<FilePreviewPane source={record()} />);

    await waitFor(() => expect(fetchRecordBlob).toHaveBeenCalledWith(
      '/api/records/documents/doc-1/file',
      { page: 1, render: true, asImage: true },
    ));
  });

  it('draws the page and never frames anything', async () => {
    const { container } = render(<FilePreviewPane source={record()} />);

    await waitFor(() => expect(container.querySelector('img')).toBeTruthy());
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('pages a stored-whole PDF from the count the route reported', async () => {
    // The record says nothing about pages — a PDF stored whole is one vault
    // page however many sheets are inside it, so without the served count the
    // pager never appears and three of the four sheets are unreachable.
    render(<FilePreviewPane source={record({ pageCount: 1 })} />);

    await waitFor(() => expect(screen.getByText('Page 1 of 4')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));

    await waitFor(() => expect(screen.getByText('Page 2 of 4')).toBeTruthy());
    expect(fetchRecordBlob).toHaveBeenLastCalledWith(
      '/api/records/documents/doc-1/file',
      { page: 2, render: true, asImage: true },
    );
  });

  it('does not carry that count over to the next document', async () => {
    const { rerender } = render(<FilePreviewPane source={record({ pageCount: 1 })} />);
    await waitFor(() => expect(screen.getByText('Page 1 of 4')).toBeTruthy());

    fetchRecordBlob.mockResolvedValue({ url: 'blob:made', mimeType: 'image/jpeg', pageCount: 1 });
    rerender(
      <FilePreviewPane
        source={record({ pageCount: 1, filePath: '/api/records/documents/doc-2/file' })}
      />,
    );

    // A stale "Page 1 of 4" on a one-page record offers three sheets that are
    // not there. Derived from the source key, so it clears synchronously.
    await waitFor(() => expect(screen.queryByText('Page 1 of 4')).toBeNull());
  });
});

describe('which renderer draws it', () => {
  it('frames a .docx that came back as a PDF', async () => {
    const { container } = render(<FilePreviewPane source={record()} />);

    // The record says .docx. The bytes are a PDF. The PDF wins.
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('blob:made#toolbar=0');
  });

  it('draws a split PDF page as the image it actually is', async () => {
    fetchRecordBlob.mockResolvedValue({ url: 'blob:made', mimeType: 'image/jpeg' });

    const { container } = render(
      <FilePreviewPane source={record({ mimeType: 'application/pdf', name: 'Passport' })} />,
    );

    await waitFor(() => expect(container.querySelector('img')).toBeTruthy());
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('renders text as text, and does not frame it', async () => {
    fetchRecordBlob.mockResolvedValue({
      text: 'policy,number\nLIC,12345\n', mimeType: 'text/plain; charset=utf-8',
    });

    const { container } = render(
      <FilePreviewPane source={record({ mimeType: 'text/csv', name: 'Policies' })} />,
    );

    await waitFor(() => expect(screen.getByText(/LIC,12345/)).toBeTruthy());
    expect(container.querySelector('iframe')).toBeNull();
    expect((URL as any).createObjectURL).not.toHaveBeenCalled();
  });

  it('says so plainly for something it still cannot draw', async () => {
    fetchRecordBlob.mockResolvedValue({ url: 'blob:made', mimeType: 'application/zip' });

    render(<FilePreviewPane source={record({ name: 'Backup' })} />);

    await waitFor(() => expect(
      screen.getByText('This file type cannot be shown here.'),
    ).toBeTruthy());
  });
});

describe('the route’s refusal', () => {
  it('is shown as the reason the route gave, not a blank box', async () => {
    fetchRecordBlob.mockRejectedValue(
      new Error('This document is too large to show here. Download it to open it.'),
    );

    render(<FilePreviewPane source={record()} fallbackAction={<button>Download</button>} />);

    await waitFor(() => expect(screen.getByText(/too large to show here/)).toBeTruthy());
    // The way out is offered alongside the reason.
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
  });
});

describe('a multi-page record', () => {
  it('is paged, and asks the route for the page it moved to', async () => {
    render(<FilePreviewPane source={record({ pageCount: 3 })} />);

    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));

    await waitFor(() => expect(screen.getByText('Page 2 of 3')).toBeTruthy());
    expect(fetchRecordBlob).toHaveBeenLastCalledWith(
      '/api/records/documents/doc-1/file',
      { page: 2, render: true, asImage: false },
    );
  });

  it('starts a DIFFERENT record at its own first page', async () => {
    // Not a reset in an effect: that runs after the render which already fired
    // the fetch, so the new record was asked for page three and 404ed.
    const { rerender } = render(<FilePreviewPane source={record({ pageCount: 5 })} />);
    await waitFor(() => expect(screen.getByText('Page 1 of 5')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(screen.getByText('Page 2 of 5')).toBeTruthy());

    rerender(
      <FilePreviewPane
        source={record({ pageCount: 5, filePath: '/api/records/documents/doc-2/file' })}
      />,
    );

    await waitFor(() => expect(screen.getByText('Page 1 of 5')).toBeTruthy());
    expect(fetchRecordBlob).toHaveBeenLastCalledWith(
      '/api/records/documents/doc-2/file',
      { page: 1, render: true, asImage: false },
    );
  });

  it('offers no pager at all for a single page', async () => {
    render(<FilePreviewPane source={record()} />);

    await waitFor(() => expect(fetchRecordBlob).toHaveBeenCalled());
    expect(screen.queryByText(/Page 1 of/)).toBeNull();
  });
});

describe('a file straight off the picker', () => {
  it('is drawn from its own bytes, with no round trip', async () => {
    const file = new File(['x'], 'scan.png', { type: 'image/png' });

    const { container } = render(<FilePreviewPane source={{ kind: 'file', file }} />);

    await waitFor(() => expect(container.querySelector('img')).toBeTruthy());
    expect(fetchRecordBlob).not.toHaveBeenCalled();
  });

  it('READS a text file rather than framing it', async () => {
    // The text renderer draws a string, not an object URL. Handing it only a
    // blob drew an empty <pre> — so a .txt or .csv on the "uploading now" side
    // of the duplicate prompt was a blank panel beside a legible one.
    const file = new File(['policy,number\nLIC,12345\n'], 'policies.csv', {
      type: 'text/csv',
    });

    const { container } = render(<FilePreviewPane source={{ kind: 'file', file }} />);

    await waitFor(() => expect(screen.getByText(/LIC,12345/)).toBeTruthy());
    expect(container.querySelector('iframe')).toBeNull();
    expect(fetchRecordBlob).not.toHaveBeenCalled();
  });
});
