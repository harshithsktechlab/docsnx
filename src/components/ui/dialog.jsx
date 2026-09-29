import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // A 12px gutter below `sm`: a plain `w-full` put every modal flush
      // against both edges of a phone, with its rounded corners cut off by the
      // screen. Callers' own `max-w-*` overrides still apply from `sm` up.
      'fixed left-[50%] top-[50%] z-50 w-[calc(100%-1.5rem)] sm:w-full max-w-lg translate-x-[-50%] translate-y-[-50%]',
        'bg-popover border border-border rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.4)]',
        'max-h-[90vh] flex flex-col',
        '[&>*:not([data-dialog-header]):not([data-dialog-footer]):not([data-dialog-close])]:px-6 [&>*:not([data-dialog-header]):not([data-dialog-footer]):not([data-dialog-close])]:sm:px-7',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
        'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        data-dialog-close="true"
        className="absolute right-4 top-4 rounded-lg p-1.5 text-muted-foreground ring-offset-background transition-all hover:text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }) => (
  <div
    data-dialog-header="true"
    className={cn('flex flex-col space-y-1.5 px-6 sm:px-7 pt-6 pb-4 pr-12 border-b border-border/70', className)}
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }) => (
  <div
    data-dialog-footer="true"
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end gap-3 px-6 sm:px-7 py-4 bg-muted/30 border-t border-border/70', className)}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-bold leading-snug tracking-tight text-foreground', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground leading-relaxed mt-1', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

const DialogBody = ({ className, ...props }) => (
  <div className={cn('flex-1 overflow-y-auto px-6 sm:px-7 py-5', className)} {...props} />
);
DialogBody.displayName = 'DialogBody';

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogBody,
};
