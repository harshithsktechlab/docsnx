'use client';

/**
 * A date, typed and shown DD/MM/YYYY whatever the browser's locale, picked from
 * a calendar this file draws, and clearable.
 *
 * The value the caller holds stays `YYYY-MM-DD` (or '' for none). While the
 * typing is incomplete or not a real day, the raw text is passed up instead of
 * a blank, so a caller that validates can say "not a valid date" rather than
 * silently dropping what was typed — `isIsoDate` is the check.
 *
 * Why not the browser's own picker: its year and month controls commit a date
 * as they are used, so picking 1985 left the field on the 1st of that month
 * and the user had to pick the day again. Here the month and year selects only
 * move the calendar; nothing is committed until a day is clicked.
 */
import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { displayToIso, isoToDisplay } from '@/lib/dateHelper';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MIN_YEAR = 1900;

export const isIsoDate = (value) => ISO.test(String(value ?? ''));

const pad = (n) => String(n).padStart(2, '0');
const toIso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** Today as `YYYY-MM-DD` in the viewer's own timezone (not UTC). */
export function todayIso() {
  const now = new Date();
  return toIso(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * @param value     `YYYY-MM-DD`, '' for none, or the raw text of an unfinished entry
 * @param onChange  called with `YYYY-MM-DD`, '' or the raw text
 * @param min,max   optional `YYYY-MM-DD` bounds; days outside them cannot be picked
 */
export function DateField({
  id, value, onChange, disabled, min, max, className, ...rest
}) {
  const iso = String(value ?? '');
  const [draft, setDraft] = useState(() => isoToDisplay(iso));
  // What this input last passed up, so a change from OUTSIDE — a reset, a
  // prefill — can be told apart from our own echo.
  const emitted = useRef(iso);
  const root = useRef(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => {
    const base = ISO.test(iso) ? iso : todayIso();
    return { year: Number(base.slice(0, 4)), month: Number(base.slice(5, 7)) - 1 };
  });

  useEffect(() => {
    if (iso === emitted.current) return;
    emitted.current = iso;
    setDraft(isoToDisplay(iso));
  }, [iso]);

  // Outside click closes the calendar.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (root.current && !root.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const emit = (next) => {
    emitted.current = next;
    onChange(next);
  };

  const type = (raw) => {
    // Slashes inserted as the digits arrive: "16102026" → "16/10/2026".
    let text = raw;
    if (/^\d+$/.test(raw) && raw.length <= 8) {
      text = [raw.slice(0, 2), raw.slice(2, 4), raw.slice(4)].filter(Boolean).join('/');
    }
    setDraft(text);
    emit(text.trim() === '' ? '' : (displayToIso(text) ?? text));
  };

  const clear = () => {
    setDraft('');
    emit('');
    setOpen(false);
  };

  const toggle = () => {
    if (!open) {
      const base = ISO.test(iso) ? iso : (max && max < todayIso() ? max : todayIso());
      setView({ year: Number(base.slice(0, 4)), month: Number(base.slice(5, 7)) - 1 });
    }
    setOpen(!open);
  };

  const pick = (day) => {
    const next = toIso(view.year, view.month, day);
    setDraft(isoToDisplay(next));
    emit(next);
    setOpen(false);
  };

  const step = (delta) => {
    const m = view.month + delta;
    setView({ year: view.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 });
  };

  const maxYear = max ? Number(max.slice(0, 4)) : new Date().getFullYear() + 30;
  const minYear = min ? Number(min.slice(0, 4)) : MIN_YEAR;
  const years = [];
  for (let y = maxYear; y >= minYear; y -= 1) years.push(y);

  const lead = new Date(view.year, view.month, 1).getDay();
  const count = new Date(view.year, view.month + 1, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  const blocked = (day) => {
    const d = toIso(view.year, view.month, day);
    return Boolean((min && d < min) || (max && d > max));
  };

  const select = 'h-8 min-w-0 rounded-lg border border-border bg-field px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const icon = 'flex h-8 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';

  return (
    <div className="relative" ref={root}>
      <Input
        aria-invalid={draft.trim() !== '' && !ISO.test(iso) ? true : undefined}
        {...rest}
        id={id}
        value={draft}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="DD/MM/YYYY"
        maxLength={10}
        disabled={disabled}
        className={cn(className, 'text-base sm:text-sm', draft ? 'pr-[4.5rem]' : 'pr-10')}
        onChange={(e) => type(e.target.value)}
      />
      {draft && !disabled && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear date"
          className="absolute inset-y-0 right-10 flex w-8 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <X size={16} />
        </button>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={toggle}
        aria-label="Pick a date from the calendar"
        aria-expanded={open}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <CalendarDays size={16} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Calendar"
          className="absolute left-0 top-full z-50 mt-1 w-full max-w-[16rem] rounded-xl border border-border bg-popover p-2 shadow-lg"
        >
          <div className="mb-1 flex items-center gap-1">
            <button type="button" className={icon} onClick={() => step(-1)} aria-label="Previous month">
              <ChevronLeft size={16} />
            </button>
            <select
              className={cn(select, 'flex-1')}
              value={view.month}
              aria-label="Month"
              onChange={(e) => setView({ ...view, month: Number(e.target.value) })}
            >
              {MONTHS.map((name, i) => <option key={name} value={i}>{name}</option>)}
            </select>
            <select
              className={select}
              value={view.year}
              aria-label="Year"
              onChange={(e) => setView({ ...view, year: Number(e.target.value) })}
            >
              {!years.includes(view.year) && <option value={view.year}>{view.year}</option>}
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button type="button" className={icon} onClick={() => step(1)} aria-label="Next month">
              <ChevronRight size={16} />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center text-xs text-muted-foreground">
            {WEEKDAYS.map((d) => <span key={d} className="py-0.5">{d}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((day, i) => {
              if (day === null) return <span key={`blank-${i}`} />;
              const selected = iso === toIso(view.year, view.month, day);
              return (
                <button
                  key={day}
                  type="button"
                  disabled={blocked(day)}
                  onClick={() => pick(day)}
                  className={cn(
                    'h-7 rounded-lg text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
                    selected && 'bg-primary text-primary-foreground hover:bg-primary',
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>

          <div className="mt-1 flex justify-between border-t border-border pt-1 text-sm">
            <button type="button" className="px-2 py-1 text-muted-foreground hover:text-foreground" onClick={clear}>
              Clear
            </button>
            <button type="button" className="px-2 py-1 text-primary hover:underline" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
