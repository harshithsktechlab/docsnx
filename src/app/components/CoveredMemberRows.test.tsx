import { describe, expect, it } from 'vitest';
import { useState, type ComponentType } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import CategoryFieldInputs from './CategoryFieldInputs';
import { parseCoveredMembers } from '@/lib/records/coveredMembers';

const FIELDS = [
  { fieldKey: 'covered_members', fieldLabel: 'Covered Members', dataType: 'longtext', isPii: true },
];

// The component is untyped JSX; only these props matter here.
const Grid = CategoryFieldInputs as ComponentType<any>;
let latest = '';
function Harness() {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <Grid
      fields={FIELDS}
      values={values}
      onChange={(key: string, next: string) => { latest = next; setValues({ [key]: next }); }}
    />
  );
}

describe('covered member rows', () => {
  it('adds, fills and removes a member through the field value alone', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /add member/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Asha ' } });
    fireEvent.change(screen.getByLabelText('Member ID'), { target: { value: '1000000001' } });
    expect(parseCoveredMembers(latest)[0]).toMatchObject({ name: 'Asha ', memberId: '1000000001' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove member 1' }));
    expect(latest).toBe('');
  });
});
