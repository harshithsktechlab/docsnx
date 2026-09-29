import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import PlanQuotaMeters from './PlanQuotaMeters';

const GB = 1024 * 1024 * 1024;

/**
 * This component was extracted out of the Shell sidebar so a phone could show
 * it too. The extraction is only safe if the arithmetic came across unchanged,
 * so these tests pin the two branches that are easy to get wrong.
 */
describe('PlanQuotaMeters', () => {
  const plan = { name: 'Pro', storageLimitGB: 50, aiCredits: 10000 };

  it('labels and scales plan storage against the PLAN limit', () => {
    const { getByText } = render(
      <PlanQuotaMeters
        planDetails={plan}
        storageData={{ currentBytes: 5 * GB, limitBytes: 50 * GB, isGoogleDrive: false }}
        aiCreditsBalance={8420}
      />
    );

    expect(getByText('Pro Storage')).toBeTruthy();
    expect(getByText(/5\.00 \/ 50 GB/)).toBeTruthy();
  });

  it('labels and scales Drive storage against the DRIVE limit, not the plan', () => {
    const { getByText, queryByText } = render(
      <PlanQuotaMeters
        planDetails={plan}
        // 15 GB of Drive, which is nothing like the 50 GB plan allowance.
        storageData={{ currentBytes: 3 * GB, limitBytes: 15 * GB, isGoogleDrive: true }}
        aiCreditsBalance={8420}
      />
    );

    expect(getByText('Drive Sync Storage')).toBeTruthy();
    expect(getByText(/3\.00 \/ 15 GB/)).toBeTruthy();
    expect(queryByText('Pro Storage')).toBeNull();
  });

  it('turns amber once the last 15% is reached, on either kind of storage', () => {
    // The threshold lives in src/lib/storagePressure.ts, and this bar is the
    // surface a tenant reads it from. A bar that stays primary-coloured at 90%
    // full contradicts the toast that just told them to free space.
    const { container } = render(
      <PlanQuotaMeters
        planDetails={plan}
        storageData={{ currentBytes: 45 * GB, limitBytes: 50 * GB, isGoogleDrive: false }}
      />
    );
    expect(container.querySelector('.bg-amber-500')).toBeTruthy();
    expect(container.querySelector('.bg-destructive')).toBeNull();
  });

  it('turns destructive at full, including on a Drive limit', () => {
    // The Drive branch used to be pinned emerald, so a tenant whose Drive was
    // 100% full read a green bar.
    const { container } = render(
      <PlanQuotaMeters
        planDetails={plan}
        storageData={{ currentBytes: 15 * GB, limitBytes: 15 * GB, isGoogleDrive: true }}
      />
    );
    expect(container.querySelector('.bg-destructive')).toBeTruthy();
  });

  it('reports bytes used, and no fill, when the Drive quota has not been read', () => {
    // `unlimited` here means the ceiling is UNKNOWN, not enormous. Scaling a
    // bar against it would draw an empty disk for a tenant who may be full.
    const { getByText, container } = render(
      <PlanQuotaMeters
        planDetails={plan}
        storageData={{ currentBytes: 3 * GB, limitBytes: null, unlimited: true, isGoogleDrive: true }}
      />
    );
    expect(getByText('3.00 GB used')).toBeTruthy();
    expect((container.querySelector('.rounded-full > div') as HTMLElement)?.style.width).toBe('0%');
  });

  it('shows the live credit balance against the allowance', () => {
    const { getByText } = render(
      <PlanQuotaMeters planDetails={plan} storageData={null} aiCreditsBalance={8420} />
    );
    expect(getByText('8,420 / 10,000')).toBeTruthy();
  });

  it('falls back to the full allowance when no balance has been recorded', () => {
    // A false zero here reads as "the AI you paid for is gone", so an absent
    // ledger row must render as full, not empty.
    const { getByText } = render(
      <PlanQuotaMeters planDetails={plan} storageData={null} aiCreditsBalance={undefined} />
    );
    expect(getByText('10,000 / 10,000')).toBeTruthy();
  });

  it('renders a zero balance as zero rather than falling back', () => {
    const { getByText } = render(
      <PlanQuotaMeters planDetails={plan} storageData={null} aiCreditsBalance={0} />
    );
    expect(getByText('0 / 10,000')).toBeTruthy();
  });

  it('renders nothing without a plan', () => {
    const { container } = render(<PlanQuotaMeters planDetails={null} storageData={null} />);
    expect(container.firstChild).toBeNull();
  });
});
