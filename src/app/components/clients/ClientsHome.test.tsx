/**
 * What Client Documents draws for each choice: the chooser until a workspace admin
 * has chosen; then ONLY the kind(s) the company keeps — one kind has no tab strip
 * and no sign of the other, both kinds have the two tabs.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co-1' }),
  useRouter: () => ({ push, replace: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/clientAuth', () => ({
  clientGetMe: vi.fn(async () => ({ success: true, user: { id: 'u1', role: 'TENANT_ADMIN' } })),
  clientCan: () => true,
}));

let types: any;
/** What `GET /api/clients?...` answers with. */
let clientRows: any[] = [];
const apiCall = vi.fn(async (url: string) => {
  if (url.includes('/api/clients/types')) return { json: { success: true, ...types }, res: { ok: true } };
  if (url.includes('/api/clients/subcategories')) return { json: { success: true, enabledCount: 3, groups: [] }, res: { ok: true } };
  if (url.includes('/api/clients?')) return { json: { success: true, clients: clientRows }, res: { ok: true } };
  return { json: { success: true }, res: { ok: true } };
});
vi.mock('@/lib/net/apiRequest', () => ({ apiCall: (...a: any[]) => (apiCall as any)(...a) }));

import ClientsHome from '@/app/components/clients/ClientsHome';

const choice = (individual: boolean, company: boolean, canChange = true) => ({ chosen: true, individual, company, canChange });

beforeEach(() => {
  apiCall.mockClear();
  push.mockClear();
  clientRows = [];
  try { window.localStorage.clear(); } catch { /* ignore */ }
});

describe('before anything is chosen', () => {
  it('shows an admin the chooser — and nothing else to do', async () => {
    types = { chosen: false, individual: false, company: false, canChange: true };
    render(<ClientsHome />);
    expect(await screen.findByText('Who do you keep documents for?')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText(/add client/i)).toBeNull();
    expect(apiCall.mock.calls.some(([u]) => String(u).startsWith('/api/clients?'))).toBe(false);
  });

  it('tells a non-admin who can set it up, with no chooser', async () => {
    types = { chosen: false, individual: false, company: false, canChange: false };
    render(<ClientsHome />);
    expect(await screen.findByText(/not set up yet/i)).toBeTruthy();
    expect(screen.getByText(/ask a workspace admin/i)).toBeTruthy();
    expect(screen.queryByText('Who do you keep documents for?')).toBeNull();
  });
});

describe('after choosing', () => {
  it('Individual only: no tabs at all, and no mention of Company', async () => {
    types = choice(true, false);
    render(<ClientsHome />);
    expect(await screen.findByText('Individual clients')).toBeTruthy();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByText('Company')).toBeNull();
    await waitFor(() => expect(apiCall.mock.calls.some(([u]) => String(u).includes('/api/clients?type=individual'))).toBe(true));
    expect(apiCall.mock.calls.some(([u]) => String(u).includes('type=company'))).toBe(false);
  });

  it('Company only: no tabs, and it never asks for individual clients', async () => {
    types = choice(false, true);
    render(<ClientsHome />);
    expect(await screen.findByText('Company clients')).toBeTruthy();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    await waitFor(() => expect(apiCall.mock.calls.some(([u]) => String(u).includes('/api/clients?type=company'))).toBe(true));
    expect(apiCall.mock.calls.some(([u]) => String(u).includes('type=individual'))).toBe(false);
  });

  it('Both: the two tabs', async () => {
    types = choice(true, true);
    render(<ClientsHome />);
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    expect(screen.getByRole('tab', { name: /individual/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /company/i })).toBeTruthy();
  });

  it('a remembered tab for a kind that is not kept falls back to the one that is', async () => {
    window.localStorage.setItem('docsnx.clients.type', 'company');
    types = choice(true, false);
    render(<ClientsHome />);
    await waitFor(() => expect(apiCall.mock.calls.some(([u]) => String(u).includes('/api/clients?type=individual'))).toBe(true));
    expect(apiCall.mock.calls.some(([u]) => String(u).includes('type=company'))).toBe(false);
  });

  it('offers "Change client types" to an admin only', async () => {
    types = choice(true, true, true);
    const { unmount } = render(<ClientsHome />);
    expect(await screen.findByText(/change client types/i)).toBeTruthy();
    unmount();
    types = choice(true, true, false);
    render(<ClientsHome />);
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    expect(screen.queryByText(/change client types/i)).toBeNull();
  });
});

describe('the clients, as a list', () => {
  const RAM = { id: 'c-ram', clientType: 'individual', displayName: 'Ram Das', mobile: '+91 98765 43210', email: 'ramdas@abc.com', panMasked: '\u2022\u2022\u2022\u2022234E', gstinMasked: null };
  const SHREE = { id: 'c-shree', clientType: 'individual', displayName: 'Shree Ram', mobile: null, email: null, panMasked: null, gstinMasked: null };

  it('draws one table row per client, under Name / Contact number / Email headings — not cards', async () => {
    types = choice(true, false);
    clientRows = [RAM, SHREE];
    render(<ClientsHome />);
    await screen.findByText('Ram Das');

    expect(screen.getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual(['Name', 'Contact number', 'Email', 'Open']);
    // header row + one per client
    expect(screen.getAllByRole('row')).toHaveLength(3);
    // The old cards were buttons named for the client.
    expect(screen.queryByRole('button', { name: /Ram Das/ })).toBeNull();
  });

  it('keeps the order the API sent (A to Z is the server\'s job)', async () => {
    types = choice(true, false);
    clientRows = [RAM, SHREE];
    render(<ClientsHome />);
    await screen.findByText('Shree Ram');
    const names = screen.getAllByRole('row').slice(1).map((r) => r.textContent ?? '');
    expect(names[0]).toContain('Ram Das');
    expect(names[1]).toContain('Shree Ram');
  });

  it('shows the contact number and the email — and NO PAN or GSTIN, masked or not', async () => {
    types = choice(true, false);
    clientRows = [RAM, SHREE];
    render(<ClientsHome />);
    await screen.findByText('Ram Das');
    const ram = screen.getAllByRole('row')[1];
    expect(ram.textContent).toContain('+91 98765 43210');
    expect(ram.textContent).toContain('ramdas@abc.com');
    // Identifiers are on the client's own page, never in the list.
    expect(ram.textContent).not.toMatch(/PAN|234E|GSTIN/);
    expect(document.body.textContent).not.toMatch(/PAN|GSTIN/);
  });

  it('shows a dash where a client has no contact number or no email', async () => {
    types = choice(true, false);
    clientRows = [RAM, { ...SHREE, mobile: null, email: 'shree@abc.com' }, { ...SHREE, id: 'c-3', displayName: 'Tara Nair', email: null, mobile: '99999 11111' }];
    render(<ClientsHome />);
    await screen.findByText('Shree Ram');
    const rows = screen.getAllByRole('row');
    expect(rows[2].querySelectorAll('[aria-label="No contact number"]')).toHaveLength(1);
    expect(rows[2].querySelectorAll('[aria-label="No email"]')).toHaveLength(0);
    expect(rows[3].querySelectorAll('[aria-label="No email"]')).toHaveLength(1);
    expect(rows[3].querySelectorAll('[aria-label="No contact number"]')).toHaveLength(0);
  });

  it('opens the client when the row is clicked, or Enter / Space is pressed on it', async () => {
    types = choice(true, false);
    clientRows = [RAM, SHREE];
    render(<ClientsHome />);
    await screen.findByText('Ram Das');
    const rows = screen.getAllByRole('row');

    fireEvent.click(rows[1]);
    expect(push).toHaveBeenLastCalledWith('/business/co-1/clients/c-ram');
    fireEvent.keyDown(rows[2], { key: 'Enter' });
    expect(push).toHaveBeenLastCalledWith('/business/co-1/clients/c-shree');
    fireEvent.keyDown(rows[1], { key: ' ' });
    expect(push).toHaveBeenLastCalledWith('/business/co-1/clients/c-ram');
    fireEvent.keyDown(rows[1], { key: 'a' });
    expect(push).toHaveBeenCalledTimes(3);
  });

  it('a company client is listed the same way — same columns, still no GSTIN or PAN', async () => {
    types = choice(false, true);
    clientRows = [{ id: 'c-acme', clientType: 'company', displayName: 'Acme Traders', mobile: '080 4000 1234', email: 'ap@acme.in', panMasked: '\u2022\u2022\u2022\u2022234D', gstinMasked: '\u2022\u2022\u2022\u20221Z7' }];
    render(<ClientsHome />);
    await screen.findByText('Acme Traders');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual(['Name', 'Contact number', 'Email', 'Open']);
    const row = screen.getAllByRole('row')[1];
    expect(row.textContent).toContain('080 4000 1234');
    expect(row.textContent).toContain('ap@acme.in');
    expect(row.textContent).not.toMatch(/GSTIN|PAN|1Z7|234D/);
  });

  it('has no table at all when there are no clients — just the empty message', async () => {
    types = choice(true, false);
    clientRows = [];
    render(<ClientsHome />);
    expect(await screen.findByText(/no individual clients yet/i)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
  });
});
