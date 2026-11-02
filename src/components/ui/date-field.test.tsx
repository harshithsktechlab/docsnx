/**
 * The two things the member form's date fields got wrong: a picked date could
 * not be taken back, and moving the calendar to another year committed a date
 * on the 1st of that month before the user had chosen a day.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateField, isIsoDate } from './date-field';

function Harness({ initial = '', onChange }: { initial?: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <DateField
      id="dob"
      value={value}
      onChange={(next: string) => { setValue(next); onChange?.(next); }}
      max="2026-11-02"
    />
  );
}

describe('DateField', () => {
  it('commits nothing until a day is clicked, then keeps that exact day', () => {
    const seen = vi.fn();
    render(<Harness onChange={seen} />);
    fireEvent.click(screen.getByLabelText('Pick a date from the calendar'));
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '1985' } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '9' } });
    expect(seen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '16' }));
    expect(seen).toHaveBeenLastCalledWith('1985-10-16');
    expect((screen.getByPlaceholderText('DD/MM/YYYY') as HTMLInputElement).value).toBe('16/10/1985');
  });

  it('can be cleared with the X button', () => {
    const seen = vi.fn();
    render(<Harness initial="1985-10-16" onChange={seen} />);
    fireEvent.click(screen.getByLabelText('Clear date'));
    expect(seen).toHaveBeenLastCalledWith('');
    expect((screen.getByPlaceholderText('DD/MM/YYYY') as HTMLInputElement).value).toBe('');
    expect(screen.queryByLabelText('Clear date')).toBeNull();
  });

  it('formats typed digits and passes an unreal date up as text, not as a date', () => {
    const seen = vi.fn();
    render(<Harness onChange={seen} />);
    const input = screen.getByPlaceholderText('DD/MM/YYYY');
    fireEvent.change(input, { target: { value: '16101985' } });
    expect(seen).toHaveBeenLastCalledWith('1985-10-16');
    fireEvent.change(input, { target: { value: '31/02/2000' } });
    expect(isIsoDate(seen.mock.calls.at(-1)![0])).toBe(false);
  });

  it('does not let a day after max be picked', () => {
    render(<Harness initial="2026-11-01" />);
    fireEvent.click(screen.getByLabelText('Pick a date from the calendar'));
    expect((screen.getByRole('button', { name: '3' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '2' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
