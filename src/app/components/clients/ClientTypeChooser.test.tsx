/**
 * The first screen of Client Documents: Individual, Company or Both. Rendered,
 * because what matters is what the screen lets you save and what it says when the
 * server refuses (a kind that still has clients cannot be turned off).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useParams: () => ({ companyId: 'co-1' }) }));
const apiCall = vi.fn();
vi.mock('@/lib/net/apiRequest', () => ({ apiCall: (...a: any[]) => apiCall(...a) }));

import ClientTypeChooser from '@/app/components/clients/ClientTypeChooser';

beforeEach(() => apiCall.mockReset());

describe('first run', () => {
  it('offers the three choices and cannot continue until one is picked', () => {
    render(<ClientTypeChooser initial={{ chosen: false, individual: false, company: false }} onSaved={vi.fn()} />);
    expect(screen.getByText('Who do you keep documents for?')).toBeTruthy();
    expect(screen.getByLabelText(/individual clients/i)).toBeTruthy();
    expect(screen.getByLabelText(/company clients/i)).toBeTruthy();
    expect(screen.getByLabelText(/^both/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ['individual clients', { individual: true, company: false }],
    ['company clients', { individual: false, company: true }],
    ['both', { individual: true, company: true }],
  ])('saves "%s" as exactly that choice', async (label, expected) => {
    apiCall.mockResolvedValue({ json: { success: true, chosen: true, ...expected, canChange: true }, res: { ok: true } });
    const onSaved = vi.fn();
    render(<ClientTypeChooser initial={{ chosen: false, individual: false, company: false }} onSaved={onSaved} />);
    fireEvent.click(screen.getByLabelText(new RegExp(`^${label}`, 'i')));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [url, init] = apiCall.mock.calls[0];
    expect(url).toContain('/api/clients/types');
    expect(JSON.parse(init.body)).toEqual(expected);
  });
});

describe('changing it later', () => {
  it('starts on what is stored, calls itself "Change client types", and offers Cancel', () => {
    const onCancel = vi.fn();
    render(<ClientTypeChooser initial={{ chosen: true, individual: true, company: false }} onSaved={vi.fn()} onCancel={onCancel} />);
    expect(screen.getByText('Change client types')).toBeTruthy();
    expect((screen.getByLabelText(/^individual clients/i) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows the server's own sentence when turning a kind off is refused, and does not report success", async () => {
    apiCall.mockResolvedValue({
      json: { success: false, error: 'You still have 2 individual clients. Remove those clients first, then turn this off.' },
      res: { ok: false },
    });
    const onSaved = vi.fn();
    render(<ClientTypeChooser initial={{ chosen: true, individual: true, company: true }} onSaved={onSaved} />);
    fireEvent.click(screen.getByLabelText(/^company clients/i));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('2 individual clients');
    expect(onSaved).not.toHaveBeenCalled();
  });
});
