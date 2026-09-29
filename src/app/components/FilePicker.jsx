'use client';

/**
 * A file control that is actually visible.
 *
 * This replaces a bare `<Input type="file">`, which inherited the text-input
 * styling — `h-10`, `px-4 py-2`, a translucent background — and clipped the
 * browser's own "Choose file" button inside it. On the dark theme the native
 * button renders light-on-light and, once clipped, is close to invisible: users
 * could not tell there was a control there at all.
 *
 * So the native input is hidden and driven by a real <Button>, which also lets
 * the control say the two things the native one never does: what has been
 * picked (name and size, with a way to remove it) and what may be picked
 * (`UPLOAD_ACCEPT_LABEL`).
 *
 * Type checking here is a courtesy — the POST route validates again with the
 * same list, because `accept` is a picker filter that a request can ignore.
 */
import { useId, useRef } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  UPLOAD_ACCEPT_ATTRIBUTE,
  UPLOAD_ACCEPT_LABEL,
} from '@/lib/records/uploadTypes';
import { prepareUploadFile } from '@/lib/records/fileSnapshot';

/** Bytes as something a person reads without counting zeroes. */
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilePicker({
  file,
  onChange,
  label = 'Attach a scan or document',
  hint = 'Optional — the record is saved either way, and the file can be added later.',
  error = '',
  onError,
  disabled = false,
}) {
  const inputRef = useRef(null);
  const id = useId();

  /**
   * Type, then read, then shrink, then size — see `prepareUploadFile` in
   * src/lib/records/fileSnapshot.ts for why that order and not another. The
   * file handed up is the one that will be uploaded — an in-memory copy,
   * re-encoded if it was a photo — so the name and size this control displays
   * are the real ones, and nothing on the phone can revoke it before send.
   */
  const pick = async (event) => {
    const chosen = event.target.files?.[0] || null;
    // Reset the input so re-picking the SAME file after removing it still fires
    // a change event — otherwise the control appears dead on the second try.
    // Synchronous, before any await: clearing `value` discards `files`.
    event.target.value = '';
    if (!chosen) return;

    const result = await prepareUploadFile(chosen);
    if (!result.ok) {
      onError?.(result.error);
      return;
    }
    onError?.('');
    onChange(result.file);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>

      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={UPLOAD_ACCEPT_ATTRIBUTE}
        onChange={pick}
        disabled={disabled}
        className="sr-only"
      />

      {file ? (
        <div className={cn(
          'flex items-center gap-3 rounded-xl border border-border bg-input/40 px-3 py-2.5',
          error && 'border-destructive',
        )}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileText size={16} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-xs font-semibold text-foreground">{file.name}</span>
            <span className="text-xs text-muted-foreground">{formatSize(file.size)}</span>
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              Replace
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-danger-action"
              aria-label="Remove file"
              disabled={disabled}
              onClick={() => { onChange(null); onError?.(''); }}
            >
              <X size={14} />
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className={cn(
            'h-11 w-full justify-start gap-2 border-dashed text-xs font-semibold text-muted-foreground hover:text-foreground',
            error && 'border-destructive',
          )}
        >
          <Paperclip size={15} />
          Choose a file
        </Button>
      )}

      {error ? (
        <p className="text-xs font-medium text-danger-text">{error}</p>
      ) : (
        <p className="text-xs text-faint">
          {hint} Accepted: {UPLOAD_ACCEPT_LABEL}.
        </p>
      )}
    </div>
  );
}
