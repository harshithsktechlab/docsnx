/**
 * The client page's documents table: the Document Manager's table, over one client.
 * Same columns and row controls, the client as Holder, "Module - Sub-category" under
 * each name, a Sub-category filter button with counts, bulk actions on selection.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const params = vi.hoisted(() => new URLSearchParams());
vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co-1', clientId: 'cl-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/business/co-1/clients/cl-1',
  useSearchParams: () => params,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }) }));
vi.mock('@/lib/clientAuth', () => ({ clientGetMe: vi.fn(), clientCan: () => true }));
vi.mock('@/lib/sharePrintHelper', () => ({
  shareRecord: vi.fn(), shareRecords: vi.fn(), printRecord: vi.fn(), printRecords: vi.fn(),
  downloadRecord: vi.fn(), getFileUrl: (p: string) => `/api/files/${p}`, warmShare: vi.fn(),
}));

let documents: any[] = [];
const api = vi.fn(async (url: string) => {
  if (url.startsWith('/api/documents')) {
    return { json: { success: true, documents, pagination: { page: 1, limit: 10, totalCount: documents.length, totalPages: 1 } } };
  }
  return { json: { success: true } };
});
vi.mock('@/lib/net/useWorkspaceApi', () => ({
  useWorkspaceApi: () => ({ api, companyId: 'co-1' }),
  withCompany: (u: string) => u,
}));
vi.mock('@/lib/net/apiRequest', () => ({ apiDownload: vi.fn(), apiCall: vi.fn() }));

import ClientDocuments from '@/app/components/clients/ClientDocuments';

const client = { id: 'cl-1', clientType: 'individual' as const, displayName: 'Ram Das' };
const user = { id: 'u1', role: 'TENANT_ADMIN' };

const pan = {
  id: 'd1', title: 'Ram PAN', filePath: 'f/1.pdf', fileName: '1.pdf', mimeType: 'application/pdf',
  categoryRef: { moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card', moduleName: 'Client Documents — Individual', documentName: 'PAN Card' },
  categoryModuleKey: 'biz_client_individual', categoryDocumentKey: 'identity-pan_card',
  display: { number: 'ABCDE1234F', numberLabel: 'PAN', holderName: 'Ram Das' },
  user: { name: 'Asha' }, fields: [],
};
const other = { ...pan, id: 'd2', title: 'Ram Passport', categoryRef: { moduleKey: 'biz_client_individual', documentKey: 'identity-passport', moduleName: 'Client Documents — Individual', documentName: 'Passport' }, categoryDocumentKey: 'identity-passport', display: { number: 'P123', holderName: 'Ram Das' } };

const mount = () => render(<ClientDocuments client={client} user={user} />);

beforeEach(() => { api.mockClear(); documents = [pan, other]; });

describe('ClientDocuments', () => {
  it('has the Document Manager\'s columns', async () => {
    mount();
    await screen.findAllByText('Ram PAN');
    for (const h of ['Document Name', 'Number', 'Holder', 'Uploaded By', 'Actions']) {
      expect(screen.getAllByText(h).length).toBeGreaterThan(0);
    }
  });

  it('reads the same list route, and names the client as Holder', async () => {
    mount();
    await screen.findAllByText('Ram PAN');
    expect(api.mock.calls[0][0]).toMatch(/^\/api\/documents/);
    expect(screen.getAllByText('Ram Das').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ABCDE1234F').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Asha').length).toBeGreaterThan(0);
  });

  it('shows "Module - Sub-category" under the name, not the internal client module', async () => {
    mount();
    await screen.findAllByText('Ram PAN');
    expect(screen.getAllByText('Identity - PAN Card').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Client Documents/)).toBeNull();
  });

  it('has Share and View on each row', async () => {
    mount();
    await screen.findAllByText('Ram PAN');
    // Two documents; the table and the mobile card each carry the controls.
    expect(screen.getAllByTitle('Share').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByTitle('View').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the bulk actions once rows are selected', async () => {
    mount();
    await screen.findAllByText('Ram PAN');
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[1]);
    fireEvent.click(boxes[2]);
    await waitFor(() => expect(screen.getAllByText('Delete').length).toBeGreaterThan(0));
    for (const label of ['Share', 'Print', 'Download']) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it('has no Sub-category dropdown — the sub-categories have a page of their own', async () => {
    mount();
    await screen.findAllByText('Ram PAN');
    expect(screen.queryByText(/All sub-categories/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Sub-cat/ })).toBeNull();
  });

  it('says so when the client has no documents yet', async () => {
    documents = [];
    mount();
    expect((await screen.findAllByText(/No documents for this client yet/)).length).toBeGreaterThan(0);
  });

  it('surfaces a failed fetch instead of an empty table', async () => {
    api.mockResolvedValueOnce({ json: { success: false, error: 'Forbidden' } } as any);
    mount();
    expect(await screen.findByText('Forbidden')).toBeTruthy();
  });
});
