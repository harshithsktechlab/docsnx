/**
 * The two things the member form's date fields got wrong: a picked date could
 * not be taken back, and moving the calendar to another year committed a date
 * on the 1st of that month before the user had chosen a day.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateField, isIsoDate } from './date-field';
import { Input } from './input';

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

  it('adds both slashes when typed one key at a time', () => {
    const seen = vi.fn();
    render(<Harness onChange={seen} />);
    const input = screen.getByPlaceholderText('DD/MM/YYYY') as HTMLInputElement;
    for (const key of '12032026') fireEvent.change(input, { target: { value: input.value + key } });
    expect(input.value).toBe('12/03/2026');
    expect(seen).toHaveBeenLastCalledWith('2026-03-12');
  });

  it('keeps hand-typed single digits and turns a pasted ISO date round', () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText('DD/MM/YYYY') as HTMLInputElement;
    for (const key of '1/5/2026') fireEvent.change(input, { target: { value: input.value + key } });
    expect(input.value).toBe('1/5/2026');
    fireEvent.change(input, { target: { value: '2026-03-12' } });
    expect(input.value).toBe('12/03/2026');
  });

  it('does not let a day after max be picked', () => {
    render(<Harness initial="2026-11-01" />);
    fireEvent.click(screen.getByLabelText('Pick a date from the calendar'));
    expect((screen.getByRole('button', { name: '3' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '2' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('<Input type="date">', () => {
  function Form({ initial = '', seen }: { initial?: string; seen?: (v: string) => void }) {
    const [value, setValue] = useState(initial);
    return (
      <form>
        <Input type="date" value={value} max="2026-12-31"
          onChange={(e: { target: { value: string } }) => { setValue(e.target.value); seen?.(e.target.value); }} />
        <button type="button" onClick={() => setValue('')}>reset</button>
      </form>
    );
  }
  const box = () => screen.getByPlaceholderText('DD/MM/YYYY') as HTMLInputElement;
  const typeKeys = (keys: string) => {
    for (const key of keys) fireEvent.change(box(), { target: { value: box().value + key } });
  };

  it('reports only a whole date or blank, keeping the half-typed text on screen', () => {
    const seen = vi.fn();
    render(<Form seen={seen} />);
    typeKeys('1203');
    expect(box().value).toBe('12/03');
    expect(seen).not.toHaveBeenCalled();
    expect(box().checkValidity()).toBe(false);
    typeKeys('2026');
    expect(seen).toHaveBeenLastCalledWith('2026-03-12');
    expect(box().checkValidity()).toBe(true);
    fireEvent.change(box(), { target: { value: '12/03/202' } });
    expect(seen).toHaveBeenLastCalledWith('');
    expect(box().value).toBe('12/03/202');
  });

  it('blocks an unreal date and one past max', () => {
    render(<Form />);
    typeKeys('31022026');
    expect(box().checkValidity()).toBe(false);
    fireEvent.change(box(), { target: { value: '01/01/2027' } });
    expect(box().checkValidity()).toBe(false);
  });

  it('follows a value changed by the form, and a blank field is valid', () => {
    render(<Form initial="2026-03-12" />);
    expect(box().value).toBe('12/03/2026');
    fireEvent.click(screen.getByText('reset'));
    expect(box().value).toBe('');
    expect(box().checkValidity()).toBe(true);
  });
});
