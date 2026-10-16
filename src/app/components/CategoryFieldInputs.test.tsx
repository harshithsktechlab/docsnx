/**
 * A date field is typed and shown DD/MM/YYYY whatever the browser's locale,
 * while the value the form holds stays ISO. The native `<input type="date">`
 * drew in the browser's locale, so an en-US browser showed every maturity and
 * renewal date MM/DD/YYYY.
 */
import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CategoryFieldInputs from './CategoryFieldInputs';

const FIELDS = [
  { fieldKey: 'maturity_date', fieldLabel: 'Maturity Date', dataType: 'date', isPii: false },
];

function Harness({ initial, spy }: { initial: string; spy: (v: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({ maturity_date: initial });
  return (
    <>
      <CategoryFieldInputs
        fields={FIELDS}
        values={values}
        onChange={(key: string, value: string) => {
          spy(value);
          setValues((prev) => ({ ...prev, [key]: value }));
        }}
      />
      <button type="button" onClick={() => setValues({ maturity_date: '2031-01-05' })}>external</button>
    </>
  );
}

describe('date field', () => {
  it('shows a stored ISO date DD/MM/YYYY in a text input', () => {
    render(<Harness initial="2035-03-28" spy={vi.fn()} />);
    const input = screen.getByLabelText(/Maturity Date/) as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.value).toBe('28/03/2035');
  });

  it('passes ISO up once a whole day is typed, and the raw text before', () => {
    const spy = vi.fn();
    render(<Harness initial="" spy={spy} />);
    const input = screen.getByLabelText(/Maturity Date/) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '16/10' } });
    expect(spy).toHaveBeenLastCalledWith('16/10');

    fireEvent.change(input, { target: { value: '16102026' } });
    expect(input.value).toBe('16/10/2026');
    expect(spy).toHaveBeenLastCalledWith('2026-10-16');
  });

  it('follows a value set from outside, such as an autofill', () => {
    render(<Harness initial="" spy={vi.fn()} />);
    fireEvent.click(screen.getByText('external'));
    expect((screen.getByLabelText(/Maturity Date/) as HTMLInputElement).value).toBe('05/01/2031');
  });
});
