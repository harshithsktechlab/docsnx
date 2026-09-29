/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE DUPLICATE PROMPT SHOWS BOTH DOCUMENTS AND OFFERS THREE ANSWERS     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two things this has to keep getting right, because both are how the prompt
 * misleads rather than merely looks wrong:
 *
 *   · "Keep both" appears ONLY when the server said the match can be forked.
 *     Offering it for an identifier clash would produce an answer the write
 *     path refuses — a button that 409s straight back.
 *   · The sentence is the SERVER'S. Rendering our own here is how users were
 *     told their titles clashed while looking at two different titles.
 *   · "Keep the new one" disappears when the server withdraws it. An EDIT is
 *     refused however it is confirmed, so the button re-posted the same write
 *     and re-opened this prompt on the same 409 — a loop, not a choice.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));
const fetchRecordBlob = vi.fn(async () => ({
  url: 'blob:existing', mimeType: 'application/pdf',
}));
vi.mock('@/lib/sharePrintHelper', () => ({
  fetchRecordBlob: (...a: any[]) => fetchRecordBlob(...a),
  getFileUrl: (p: string) => p,
}));

import DuplicateResolveDialog from './DuplicateResolveDialog';

const match = (over: Record<string, unknown> = {}) => ({
  error: "'Passport' already has this title, in this category.",
  requiresConfirmation: true,
  existingId: 'aaaa-1111',
  existingTitle: 'Passport',
  existingModuleKey: 'identity',
  existingDocumentKey: 'passport',
  reason: 'title',
  keepBothAllowed: true,
  keepBothTitle: 'Passport (2)',
  existingFile: {
    filePath: '/api/records/documents/aaaa-1111/file',
    fileName: 'passport.pdf',
    mimeType: 'application/pdf',
    fileSize: 2048,
    pageCount: 1,
    updatedAt: '2026-02-01T00:00:00.000Z',
  },
  ...over,
});

const handlers = () => ({
  onKeepExisting: vi.fn(),
  onKeepNew: vi.fn(),
  onKeepBoth: vi.fn(),
});

const newFile = () =>
  new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' });

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has neither.
  (URL as any).createObjectURL = vi.fn(() => 'blob:new');
  (URL as any).revokeObjectURL = vi.fn();
});

describe('DuplicateResolveDialog', () => {
  it('renders both sides, naming what is on file and what is arriving', async () => {
    render(
      <DuplicateResolveDialog open match={match()} newFile={newFile()} {...handlers()} />,
    );

    expect(screen.getByText('Already on file')).toBeTruthy();
    expect(screen.getByText('Uploading now')).toBeTruthy();
    // The stored half is fetched through the file route and framed as a blob —
    // pointing an iframe at the route itself is refused by X-Frame-Options —
    // and with `render=1`, so a .docx on file is shown rather than described.
    // `asImage` is the pane's own call (jsdom reports no PDF viewer, like a
    // phone), and is asserted where it belongs, in FilePreviewPane's tests.
    expect(fetchRecordBlob).toHaveBeenCalledWith(
      '/api/records/documents/aaaa-1111/file',
      expect.objectContaining({ page: 1, render: true }),
    );
    expect((URL as any).createObjectURL).toHaveBeenCalled();
  });

  it('uses the server’s own sentence', () => {
    render(<DuplicateResolveDialog open match={match()} newFile={newFile()} {...handlers()} />);

    expect(
      screen.getByText(/already has this title, in this category/),
    ).toBeTruthy();
  });

  it('offers all three answers, and names the copy keeping both would file', () => {
    const h = handlers();
    render(<DuplicateResolveDialog open match={match()} newFile={newFile()} {...h} />);

    fireEvent.click(screen.getByText('Keep the existing one'));
    fireEvent.click(screen.getByText('Keep both'));
    fireEvent.click(screen.getByText('Keep the new one'));

    expect(h.onKeepExisting).toHaveBeenCalledTimes(1);
    expect(h.onKeepBoth).toHaveBeenCalledTimes(1);
    expect(h.onKeepNew).toHaveBeenCalledTimes(1);
    // The resolved title is named before the user commits — in the sentence
    // above the buttons, so that naming it cannot push "Keep both" off the
    // line its two neighbours sit on.
    expect(screen.getByText(/Passport \(2\)/)).toBeTruthy();
  });

  it('hides "keep both" when the match was on a declared identifier', () => {
    render(
      <DuplicateResolveDialog
        open
        match={match({ reason: 'dedupeField', keepBothAllowed: false, keepBothTitle: null })}
        newFile={newFile()}
        {...handlers()}
      />,
    );

    expect(screen.queryByText('Keep both')).toBeNull();
    // …and says why, rather than leaving the missing answer unexplained.
    expect(screen.getByText(/cannot be kept side by side/)).toBeTruthy();
  });

  it('hides it too when the caller passed no handler for it', () => {
    // The edit path can never fork: it names the record to write onto.
    const { onKeepExisting, onKeepNew } = handlers();
    render(
      <DuplicateResolveDialog
        open
        match={match()}
        newFile={newFile()}
        onKeepExisting={onKeepExisting}
        onKeepNew={onKeepNew}
      />,
    );

    expect(screen.queryByText('Keep both')).toBeNull();
  });

  it('drops to one answer when the server says the write cannot overwrite either', () => {
    // An EDIT: it names the record it is writing onto, so neither overwriting
    // the record it collided with nor forking beside it is on offer.
    const h = handlers();
    render(
      <DuplicateResolveDialog
        open
        match={match({
          reason: 'dedupeField',
          keepBothAllowed: false,
          keepBothTitle: null,
          keepNewAllowed: false,
        })}
        newFile={newFile()}
        {...h}
      />,
    );

    expect(screen.queryByText('Keep the new one')).toBeNull();
    expect(screen.queryByText('Keep both')).toBeNull();
    expect(screen.getByText('Keep the existing one')).toBeTruthy();
    // The way out is named: go and settle it on the record on file.
    expect(screen.getByText(/another record already claims/)).toBeTruthy();
    expect(screen.getByText('Open in its workspace')).toBeTruthy();
  });

  it('keeps offering it for a body that predates the flag', () => {
    // `keepNewAllowed` absent is an ordinary refusal, not a withdrawn answer.
    const h = handlers();
    render(<DuplicateResolveDialog open match={match()} newFile={newFile()} {...h} />);

    fireEvent.click(screen.getByText('Keep the new one'));
    expect(h.onKeepNew).toHaveBeenCalledTimes(1);
  });

  it('says so rather than showing an empty frame when there is nothing to preview', () => {
    // Two reasons a record has no file here: it owns none, or the member may
    // write to that category without being allowed to read it.
    render(
      <DuplicateResolveDialog
        open
        match={match({ existingFile: null })}
        newFile={null}
        {...handlers()}
      />,
    );

    expect(fetchRecordBlob).not.toHaveBeenCalled();
    expect(screen.getByText('This record cannot be previewed here.')).toBeTruthy();
    expect(screen.getByText('The scanned pages are not available on this screen.')).toBeTruthy();
  });

  it('renders nothing at all without a match', () => {
    const { container } = render(
      <DuplicateResolveDialog open match={null} newFile={null} {...handlers()} />,
    );

    expect(container.textContent).toBe('');
  });
});
