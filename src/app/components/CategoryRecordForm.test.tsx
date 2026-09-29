/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A BUSINESS RECORD CAN BE SAVED, AND A REFUSAL POINTS AT SOMETHING      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * In a company workspace "Belongs to" is a STATEMENT naming the company —
 * <HolderSelect> renders no dropdown and never calls `onChange`, so this form's
 * `holderId` stays '' for the life of the dialog. It nonetheless refused to
 * save without one, and `holderId` is not a spec field so it owns no input:
 * every business record was refused with "1 field needs attention" over a form
 * with nothing marked and nothing focused. There was no way past it.
 *
 * Rendered rather than source-matched, because the bug lived in the gap between
 * what the picker RENDERS and what the submit ASKS for — the two things a grep
 * cannot compare.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let companyId: string | undefined = 'c0ffee00-0000-4000-8000-000000000001';

vi.mock('next/navigation', () => ({
  useParams: () => (companyId ? { companyId } : {}),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/storageToast', () => ({ toastStorageError: () => false }));
vi.mock('@/hooks/useMembers', () => ({
  useMembers: () => ({ members: [{ id: 'm1', name: 'Priya' }], canAddMembers: false }),
}));

/** The category's field spec: one required field, so a blank save is refused. */
const SPEC = {
  success: true,
  category: { documentName: 'PAN Card (Business)' },
  fields: [
    {
      // `document_title`, the real TITLE_KEY — the form asks for it by that key
      // and a spec that spells it 'title' leaves the title unanswerable.
      fieldKey: 'document_title', fieldLabel: 'Document Title', dataType: 'text', isPii: false, isRequired: true,
    },
    {
      fieldKey: 'pan_number', fieldLabel: 'PAN Number', dataType: 'text', isPii: true, isRequired: true,
    },
  ],
};

const apiRequest = vi.fn(async () => ({ ok: true, status: 200, json: SPEC }));
vi.mock('@/lib/net/apiRequest', () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  apiCall: async () => ({ json: { success: true, companies: [{ id: companyId, name: 'HSKTechlab' }] } }),
}));

const postUpload = vi.fn(async () => ({
  ok: true, status: 200, kind: 'http', json: { success: true, record: { id: 'r1' } },
}));
vi.mock('@/lib/records/uploadRequest', () => ({ postUpload: (...a: any[]) => postUpload(...a) }));

import CategoryRecordForm from './CategoryRecordForm';

const open = () => render(
  <CategoryRecordForm
    open
    onClose={vi.fn()}
    moduleKey="biz_registration"
    documentKey="pan_card"
    onCreated={vi.fn()}
  />,
);

/** The spec arrives asynchronously; the inputs do not exist before it does. */
const awaitSpec = () => waitFor(() => expect(screen.getByLabelText(/PAN Number/i)).toBeTruthy());

const fill = (label: RegExp, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

const save = () => fireEvent.click(screen.getByRole('button', { name: /save/i }));

// jsdom implements neither, and the form scrolls the first error into view.
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
}

beforeEach(() => {
  vi.clearAllMocks();
  companyId = 'c0ffee00-0000-4000-8000-000000000001';
});

describe('in a company workspace', () => {
  it('names the company instead of offering a member to pick', async () => {
    open();
    await awaitSpec();
    // The statement, not a combobox — this is why there is nothing to answer.
    expect(await screen.findByText('HSKTechlab')).toBeTruthy();
    expect(screen.queryByText('All members')).toBeNull();
  });

  it('SAVES a complete record without ever asking who it belongs to', async () => {
    open();
    await awaitSpec();
    fill(/Document Title/i, 'e - Permanent Account Number (e-PAN) Card');
    fill(/PAN Number/i, 'AAACH1234K');
    save();

    await waitFor(() => expect(postUpload).toHaveBeenCalled());
    // The "Belongs to" LABEL is still there — it names the company, which is
    // the point. What must not be there is the demand to answer it.
    expect(screen.queryByText(/Choose who this record belongs to/i)).toBeNull();
    expect(screen.queryByText(/needs? attention/i)).toBeNull();
  });

  it('sends NO holderId at all, so the record is not flagged household-wide', async () => {
    open();
    await awaitSpec();
    fill(/Document Title/i, 'PAN');
    fill(/PAN Number/i, 'AAACH1234K');
    save();

    await waitFor(() => expect(postUpload).toHaveBeenCalled());
    const body = postUpload.mock.calls[0][1] as unknown as FormData;
    // Not '' — an empty holder reads as an explicit "All members" and would set
    // is_global on a record that belongs to the company. See holderScope.ts.
    expect(body.has('holderId')).toBe(false);
  });

  it('still refuses a genuinely incomplete record — and NAMES the field', async () => {
    open();
    await awaitSpec();
    fill(/Document Title/i, 'PAN');
    save();

    // The count on its own was the whole complaint: "1 field needs attention"
    // over a form with nothing marked.
    expect(await screen.findByText('Check PAN Number')).toBeTruthy();
    expect(postUpload).not.toHaveBeenCalled();
  });
});

describe('in the personal account', () => {
  beforeEach(() => { companyId = undefined; });

  it('still requires a member, because there is a picker to answer with', async () => {
    open();
    await awaitSpec();
    fill(/Document Title/i, 'PAN');
    fill(/PAN Number/i, 'AAACH1234K');
    save();

    expect(await screen.findByText(/Choose who this record belongs to/i)).toBeTruthy();
    expect(postUpload).not.toHaveBeenCalled();
  });
});
