import * as React from 'react';
import { cn } from '@/lib/utils';

const Input = React.forwardRef(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        // `bg-field`, not `bg-input/60`: `--input` is the BORDER token (both
        // `bg-input` and `border-input` read it), and a 60% wash of it over the
        // now-tinted canvas made the field muddier than the card holding it.
        // The blur went with it — there is nothing behind an opaque fill.
        'flex h-10 w-full rounded-xl border border-border bg-field px-4 py-2 text-sm text-foreground ring-offset-background transition-all duration-200',
        // The faint tier, not the secondary one: a placeholder has to stay
        // clearly subordinate to a real value, and at full `muted-foreground`
        // an empty field reads as a filled one. It was `muted-foreground/60`,
        // which went the other way — 1.7:1, so the hint telling you this field
        // takes a mobile number as well as an email was effectively not there.
        // `--faint` is the tier that is both, in both themes.
        'placeholder:text-faint',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
