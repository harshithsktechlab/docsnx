'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   RADIO GROUP — native inputs, because one control is not worth a dep    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every other primitive in this directory wraps a Radix package, and this one
 * deliberately does not: `@radix-ui/react-radio-group` is not installed, and
 * adding a dependency to draw a control the platform already draws correctly is
 * a poor trade. Native `<input type="radio">` brings arrow-key navigation,
 * roving focus, form association and screen-reader semantics for free — the
 * things a hand-rolled div-with-role usually gets wrong.
 *
 * There is precedent in the repo: /admin/document-fields renders its settings
 * matrix with raw `<input type="checkbox">` for the same reason.
 *
 * `accent-color` does the theming. It is what makes a native control follow the
 * brand without replacing it, and it works in both light and dark.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * @param name     groups the inputs — REQUIRED, and unique per rendered group.
 *                 Two groups sharing a name behave as one control.
 * @param options  [{ value, label }]
 */
const RadioGroup = React.forwardRef(({
  name, value, options = [], disabled = false, onChange, className, ...props
}, ref) => (
  <div
    ref={ref}
    role="radiogroup"
    className={cn('flex flex-col gap-1.5 py-1', className)}
    {...props}
  >
    {options.map((option) => {
      const id = `${name}-${option.value}`;
      return (
        <label
          key={option.value}
          htmlFor={id}
          className={cn(
            'flex items-center gap-2 text-sm',
            disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          )}
        >
          <input
            type="radio"
            id={id}
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange?.(option.value)}
            className="size-4 shrink-0 accent-primary"
          />
          <span>{option.label}</span>
        </label>
      );
    })}
  </div>
));
RadioGroup.displayName = 'RadioGroup';

export { RadioGroup };
