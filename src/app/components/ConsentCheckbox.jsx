import React from 'react';
import { cn } from '@/lib/utils';
import ConsentStatement from '@/app/components/ConsentStatement';

/** The compulsory consent box. `error` is the message to show under it, if any. */
export default function ConsentCheckbox({ checked, onChange, error, disabled }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          id="consentData"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'consentData-error' : undefined}
          className={cn(
            'mt-1 w-4 h-4 shrink-0 text-primary border-border rounded focus:ring-primary',
            error && 'border-danger-border ring-1 ring-danger-border',
          )}
        />
        <label htmlFor="consentData" className="text-sm text-muted-foreground leading-snug cursor-pointer">
          <ConsentStatement />
        </label>
      </div>
      {error && (
        <p id="consentData-error" role="alert" className="text-xs font-medium text-danger-text">{error}</p>
      )}
    </div>
  );
}
