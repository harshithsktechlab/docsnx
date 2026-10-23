'use client';

/**
 * The optional label a member gives a document filed under an "Other" (0068,
 * 0084) — the global Others or a module's own `<module>/other`.
 *
 * This is where the member says what it actually is — "Gym Membership" —
 * without inventing a category. Callers render it only while the chosen
 * category takes a label (`acceptsCustomLabel`), and the server drops it for
 * anything else, so one component
 * serves the upload form, the edit modal, the Power Scan grid and the Others
 * workspace alike.
 */
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CUSTOM_SUBCATEGORY_MAX } from '@/lib/records/customSubcategory';

export default function OthersLabelInput({ id, value, onChange, disabled, error, className = '' }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <Label htmlFor={id}>Label <span className="text-muted-foreground font-normal">(optional)</span></Label>
      <Input
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        maxLength={CUSTOM_SUBCATEGORY_MAX}
        placeholder="e.g. Gym Membership"
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Name what this is. Leave blank to keep the default name.
        </p>
      )}
    </div>
  );
}
