/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A SINGLE UPLOAD THAT BELONGS TO A CLIENT                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The Document Manager's form lists the company's OWN categories, so a client's
 * PAN card read there had nowhere to go: it was filed as "PAN Card (Business)" with
 * a "Belongs to" that matched nobody. The panel is what replaces the form when the
 * read says the document is a client's. Rendered, because what matters is the gap
 * between what the screen asks for and what it posts.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const postUpload = vi.fn();
vi.mock('@/lib/records/uploadRequest', () => ({
  postUpload: (...a: any[]) => postUpload(...a),
  uploadErrorMessage: () => 'Network error',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/sharePrintHelper', () => ({
  fetchRecordBlob: vi.fn(async () => ({ url: 'blob:existing', mimeType: 'application/pdf' })),
  getFileUrl: (p: string) => p,
}));
vi.mock('@/lib/net/apiRequest', () => ({
  apiCall: vi.fn(async () => ({ json: { success: true }, res: { ok: true } })),
}));

import ClientDocPanel from '@/app/components/clients/ClientDocPanel';

const CLIENT_PAIR = { moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' };

function scanFor(overrides: Record<string, any> = {}) {
  return {
    success: true,
    category: { id: 'cat-pan', ...CLIENT_PAIR, documentName: 'PAN Card' },
    fields: { pan_number: 'ABCPD1234E', document_title: 'ignored' },
    clientOwner: {
      proposal: {
        kind: 'client', owner: 'individual', via: 'name', attention: false, noteText: '',
        reason: 'The name "RAM DAS" matches Ram Das.', sourceName: 'PAN Card',
        read: { name: 'RAM DAS', type: 'individual', ids: { pan: 'ABCPD1234E' } },
      },
      clientId: 'client-ram',
      sourcePair: { moduleKey: 'identity', documentKey: 'pan_card' },
      clients: [
        { id: 'client-ram', clientType: 'individual', displayName: 'Ram Das' },
        { id: 'client-sita', clientType: 'individual', displayName: 'Sita Devi' },
      ],
      enabled: { individual: ['identity-pan_card'], company: [] },
      categoryNames: {
        'biz_client_individual/identity-pan_card': 'PAN Card',
        'biz_client_individual/uncategorized': 'Others',
      },
      categoryIds: {
        'biz_client_individual/identity-pan_card': 'cat-pan',
        'biz_client_individual/uncategorized': 'cat-others',
      },
      ...overrides,
    },
  };
}

const FILE = new File(['x'], 'RamDas_PAN.png', { type: 'image/png' });

function mount(scan: any, extra: Record<string, any> = {}) {
  const props = {
    file: FILE, scan, title: 'PAN Card - Ram Das', searchText: 'words', usageIds: ['u1'],
    onSaved: vi.fn(), onChooseOwn: vi.fn(), onUseNormalForm: vi.fn(), ...extra,
  };
  render(<ClientDocPanel {...props} />);
  return props;
}

beforeEach(() => { postUpload.mockReset(); toast.success.mockReset(); });

describe('a recognised client', () => {
  it('names the client, says why, and saves under that client with the read values', async () => {
    postUpload.mockResolvedValue({ ok: true, status: 200, json: { success: true } });
    const props = mount(scanFor());

    expect(screen.getByText(/looks like a client/i)).toBeTruthy();
    expect(screen.getAllByText(/matches Ram Das/).length).toBeGreaterThan(0);
    // What the scan read is shown, so it can be checked before saving.
    expect(screen.getByText('ABCPD1234E')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /save to client/i }));
    await waitFor(() => expect(postUpload).toHaveBeenCalledTimes(1));

    const [url, body] = postUpload.mock.calls[0];
    expect(url).toContain('/api/documents');
    expect(url).toContain('companyId=co-1');
    expect(body.get('clientId')).toBe('client-ram');
    expect(body.get('categoryId')).toBe('cat-pan');
    expect(body.get('title')).toBe('PAN Card - Ram Das');
    expect(body.get('taxonomyFields')).toBe('true');
    expect(JSON.parse(body.get('metadata'))).toEqual({ pan_number: 'ABCPD1234E', document_title: 'PAN Card - Ram Das' });
    expect(body.get('aiUsageIds')).toBe('["u1"]');
    // A client document has no "Belongs to" member.
    expect(body.get('holderId')).toBeNull();
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith('client-ram'));
  });

  it('shows the server\'s own words when the save is refused (e.g. nothing configured)', async () => {
    postUpload.mockResolvedValue({
      ok: false, kind: 'http', status: 409,
      json: { error: 'Choose the document types you keep for these clients first.' },
    });
    const props = mount(scanFor());
    fireEvent.click(screen.getByRole('button', { name: /save to client/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Choose the document types');
    expect(props.onSaved).not.toHaveBeenCalled();
  });
});

describe('an owner nobody recognises', () => {
  const unknown = () => scanFor({
    clientId: null,
    proposal: {
      kind: 'unknown', owner: 'individual', via: null, attention: true, noteText: '',
      reason: '"Vikram Singh" is neither this company nor one of your clients.', sourceName: 'PAN Card',
      read: { name: 'Vikram Singh', type: 'individual', ids: {} },
    },
  });

  it('cannot be saved until a client is chosen', () => {
    mount(unknown());
    expect((screen.getByRole('button', { name: /save to client/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(postUpload).not.toHaveBeenCalled();
  });

  it('can be saved once a client is chosen from the picker', async () => {
    postUpload.mockResolvedValue({ ok: true, status: 200, json: { success: true } });
    mount(unknown());
    fireEvent.change(screen.getByLabelText(/whose document is this/i), { target: { value: 'client:client-sita' } });
    const save = screen.getByRole('button', { name: /save to client/i }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(postUpload).toHaveBeenCalled());
    expect(postUpload.mock.calls[0][1].get('clientId')).toBe('client-sita');
  });
});

describe('handing back to the ordinary form', () => {
  it('choosing Own company reads the file again without client matching', () => {
    const props = mount(scanFor());
    fireEvent.change(screen.getByLabelText(/whose document is this/i), { target: { value: 'own' } });
    expect(props.onChooseOwn).toHaveBeenCalledTimes(1);
    expect(postUpload).not.toHaveBeenCalled();
  });

  it('"Use the normal form" gives the form back', () => {
    const props = mount(scanFor());
    fireEvent.click(screen.getByText(/use the normal form/i));
    expect(props.onUseNormalForm).toHaveBeenCalledTimes(1);
  });
});

describe('a document already on file for this client', () => {
  const conflict = (over: Record<string, unknown> = {}) => ({
    ok: false, kind: 'http', status: 409,
    json: {
      error: "'PAN Card - Ram Das' already has this title, in this category.",
      requiresConfirmation: true,
      existingId: 'doc-old',
      existingTitle: 'PAN Card - Ram Das',
      existingModuleKey: 'biz_client_individual',
      existingDocumentKey: 'identity-pan_card',
      reason: 'title',
      keepBothAllowed: true,
      keepBothTitle: 'PAN Card - Ram Das (2)',
      keepNewAllowed: true,
      existingFile: null,
      ...over,
    },
  });
  const save = () => fireEvent.click(screen.getByRole('button', { name: /save to client/i }));

  it('shows the old and new side by side instead of a dead-end message', async () => {
    postUpload.mockResolvedValueOnce(conflict());
    const props = mount(scanFor());
    save();
    expect(await screen.findByText('Duplicate Document Found')).toBeTruthy();
    expect(screen.getByText('Already on file')).toBeTruthy();
    expect(screen.getByText('Uploading now')).toBeTruthy();
    expect(screen.queryByText(/open the client.s page to replace/i)).toBeNull();
    // The link goes to the client's own page, not a sub-category path.
    expect(screen.getByRole('link', { name: /open in its workspace/i }).getAttribute('href'))
      .toBe('/business/co-1/clients/client-ram');
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it('"Keep the new one" posts again with replaceId', async () => {
    postUpload.mockResolvedValueOnce(conflict()).mockResolvedValueOnce({ ok: true, status: 200, json: { success: true } });
    const props = mount(scanFor());
    save();
    fireEvent.click(await screen.findByRole('button', { name: /keep the new one/i }));
    await waitFor(() => expect(postUpload).toHaveBeenCalledTimes(2));
    const body = postUpload.mock.calls[1][1];
    expect(body.get('replaceId')).toBe('doc-old');
    expect(body.get('keepBoth')).toBeNull();
    expect(body.get('clientId')).toBe('client-ram');
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith('client-ram'));
  });

  it('"Keep both" posts again with keepBoth', async () => {
    postUpload.mockResolvedValueOnce(conflict()).mockResolvedValueOnce({ ok: true, status: 200, json: { success: true } });
    const props = mount(scanFor());
    save();
    fireEvent.click(await screen.findByRole('button', { name: /keep both/i }));
    await waitFor(() => expect(postUpload).toHaveBeenCalledTimes(2));
    const body = postUpload.mock.calls[1][1];
    expect(body.get('keepBoth')).toBe('true');
    expect(body.get('replaceId')).toBeNull();
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith('client-ram'));
  });

  it('"Keep the existing one" posts nothing more and leaves the panel open', async () => {
    postUpload.mockResolvedValueOnce(conflict());
    const props = mount(scanFor());
    save();
    fireEvent.click(await screen.findByRole('button', { name: /keep the existing one/i }));
    await waitFor(() => expect(screen.queryByText('Duplicate Document Found')).toBeNull());
    expect(postUpload).toHaveBeenCalledTimes(1);
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId('client-doc-panel')).toBeTruthy();
  });

  it('does not offer "Keep both" for an identifier match', async () => {
    postUpload.mockResolvedValueOnce(conflict({ reason: 'dedupeField', keepBothAllowed: false, keepBothTitle: null }));
    mount(scanFor());
    save();
    await screen.findByRole('button', { name: /keep the new one/i });
    expect(screen.queryByRole('button', { name: /keep both/i })).toBeNull();
  });
});
