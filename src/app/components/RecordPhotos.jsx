'use client';

/**
 * A record's photo attachments (0069) — the thumbnail every list draws, and the
 * strip the add/edit form uses to add and remove them.
 *
 * The bytes come from the record file route with `?attachment=<id>`, which
 * applies the same view / company / share gates as the record's own document.
 * A record's `filePath` is no help here: an item with photos and no invoice has
 * none, so the URL is built from the record's scope and id.
 */
import { useEffect, useRef, useState } from 'react';
import { Camera, ImageIcon, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { fetchRecordBlob } from '@/lib/sharePrintHelper';

export function attachmentUrl(scope, recordId, attachmentId, { thumb = false, download = false } = {}) {
  const qs = new URLSearchParams({ attachment: attachmentId });
  if (thumb) qs.set('thumb', '1');
  if (download) qs.set('download', '1');
  return `/api/records/${scope}/${recordId}/file?${qs.toString()}`;
}

/**
 * One stored photo, fetched once it scrolls into view and released on unmount
 * — a list of a hundred items must not decrypt a hundred photos up front.
 */
export function AttachmentThumb({ scope, recordId, attachment, className, onClick }) {
  const ref = useRef(null);
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || !scope || !recordId || !attachment) return undefined;
    let url = null;
    let cancelled = false;
    const load = async () => {
      try {
        // The shared transport: it decrypts nothing itself, it just turns the
        // file route's answer into an object URL — or throws its message.
        const result = await fetchRecordBlob(
          attachmentUrl(scope, recordId, attachment.id, { thumb: attachment.hasThumb }),
        );
        url = result.url || null;
        if (cancelled) { if (url) URL.revokeObjectURL(url); url = null; return; }
        setSrc(url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        load();
      }
    }, { rootMargin: '200px' });
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [scope, recordId, attachment?.id, attachment?.hasThumb]); // eslint-disable-line react-hooks/exhaustive-deps

  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      ref={ref}
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted',
        onClick && 'hover:ring-2 hover:ring-primary/40',
        className || 'h-10 w-10',
      )}
      title={attachment?.name}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={attachment?.name || 'Photo'} className="h-full w-full object-cover" />
      ) : failed ? (
        <ImageIcon size={14} className="text-muted-foreground" />
      ) : (
        <Loader2 size={12} className="animate-spin text-muted-foreground" />
      )}
    </Tag>
  );
}

/** A photo chosen in this form and not yet uploaded. */
function PendingThumb({ file, onRemove, disabled }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <span className="relative inline-flex h-16 w-16 overflow-hidden rounded-md border border-dashed border-primary/50">
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={file.name} className="h-full w-full object-cover" />
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-foreground shadow"
      >
        <X size={11} />
      </button>
    </span>
  );
}

/**
 * The form's photo strip. Holds nothing itself: the form owns `pending`
 * (Files to upload) and `removed` (stored ids to delete) and sends both after
 * the record itself has saved — a photo needs a record id to belong to.
 */
export function RecordPhotos({
  slot, scope, recordId, existing = [], pending = [], removed = [],
  onAdd, onRemovePending, onRemoveExisting, disabled,
}) {
  const inputRef = useRef(null);
  const kept = existing.filter((a) => !removed.includes(a.id));
  const room = slot.max - kept.length - pending.length;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5">
          <Camera size={14} className="text-primary" />
          {slot.label}
        </Label>
        <span className="text-xs text-muted-foreground">
          {kept.length + pending.length} / {slot.max}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {kept.map((a) => (
          <span key={a.id} className="relative inline-flex">
            <AttachmentThumb scope={scope} recordId={recordId} attachment={a} className="h-16 w-16" />
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRemoveExisting(a.id)}
              aria-label={`Remove ${a.name}`}
              className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-foreground shadow"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        {pending.map((file, i) => (
          <PendingThumb
            key={`${file.name}-${i}`}
            file={file}
            disabled={disabled}
            onRemove={() => onRemovePending(i)}
          />
        ))}
        {room > 0 && (
          <Button
            type="button"
            variant="outline"
            className="h-16 w-16 flex-col gap-1 border-dashed text-xs"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <Camera size={16} />
            Add
          </Button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []).slice(0, Math.max(0, room));
            if (files.length) onAdd(files);
            e.target.value = '';
          }}
        />
      </div>
      {removed.length > 0 && (
        <p className="text-xs text-amber-600">
          {removed.length} photo{removed.length === 1 ? '' : 's'} will be removed when you save.
        </p>
      )}
    </div>
  );
}
