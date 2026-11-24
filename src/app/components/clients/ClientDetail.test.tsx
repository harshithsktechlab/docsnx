/** The client page: basic info, then the documents TABLE — no tile grid any more. */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ clientId: 'cl-1' }),
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => '/business/co-1/clients/cl-1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/clientAuth', () => ({
  clientGetMe: vi.fn(async () => ({ success: true, user: { id: 'u1', role: 'TENANT_ADMIN' } })),
  clientCan: () => true,
}));
const push = vi.hoisted(() => vi.fn());
const api = vi.fn(async (url: string) => {
  if (url.endsWith('/counts')) return { json: { success: true, counts: { 'identity-pan_card': 1 } } };
  if (url.includes('/subcategories')) {
    return { json: { success: true, groups: [{ moduleKey: 'identity', moduleName: 'Identity', items: [{ documentKey: 'identity-pan_card', documentName: 'PAN Card', enabled: true }] }] } };
  }
  return { json: { success: true, client: { id: 'cl-1', clientType: 'individual', displayName: 'Ram Das', details: { mobile: '9876543210' } } } };
});
vi.mock('@/lib/net/useWorkspaceApi', () => ({ useWorkspaceApi: () => ({ api, companyId: 'co-1' }), withCompany: (u: string) => u }));
vi.mock('@/app/components/clients/ClientDocuments', () => ({ default: () => <div>DOCUMENTS TABLE</div> }));
vi.mock('@/app/components/clients/ClientFormDialog', () => ({ default: () => null }));

import ClientDetail from '@/app/components/clients/ClientDetail';

describe('ClientDetail', () => {
  it('shows the client, the documents table and an Add document button — and no tiles', async () => {
    render(<ClientDetail />);
    expect(await screen.findByText('DOCUMENTS TABLE')).toBeTruthy();
    expect(screen.getAllByText('Ram Das').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /add document/i })).toBeTruthy();
    // The old tile grid showed the type's name with its count as a button.
    expect(screen.queryByRole('button', { name: /PAN Card/ })).toBeNull();
    expect(screen.queryByText('Others')).toBeNull();
  });

  it('has a Sub-categories button that opens the page of every sub-category', async () => {
    render(<ClientDetail />);
    await screen.findByText('DOCUMENTS TABLE');
    fireEvent.click(screen.getByRole('button', { name: /sub-categories/i }));
    expect(push).toHaveBeenCalledWith('/business/co-1/clients/cl-1/subcategories');
  });
});
