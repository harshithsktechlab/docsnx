'use client';

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  bodyClassName,
  maxWidth = 'max-w-lg',
}) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose && onClose()}>
      <DialogContent className={cn(maxWidth, className)}>
        {(title || description) && (
          <DialogHeader>
            {title && <DialogTitle>{title}</DialogTitle>}
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
        )}
        <DialogBody className={cn('px-6 sm:px-7 py-5', bodyClassName)}>{children}</DialogBody>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title = 'Are you sure?',
  description = 'This action cannot be undone.',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'destructive', // 'destructive' | 'default' | 'primary'
  loading = false,
  icon,
}) {
  const IconComponent =
    icon ||
    (variant === 'destructive' ? (
      <AlertTriangle className="h-6 w-6 text-danger-text" />
    ) : (
      <Info className="h-6 w-6 text-primary" />
    ));

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !loading && onClose && onClose()}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        <div className="px-6 sm:px-7 pt-6 sm:pt-7 pb-6">
          <div className="flex items-start gap-4 sm:gap-5">
            <div
              className={cn(
                'flex h-12 w-12 shrink-0 items-center justify-center rounded-full',
                variant === 'destructive'
                  ? 'bg-danger-surface text-danger-text'
                  : 'bg-primary/10 text-primary'
              )}
            >
              {IconComponent}
            </div>
            <div className="flex-1 space-y-2 pt-0.5">
              <h3 className="text-lg font-bold leading-snug text-foreground tracking-tight">{title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
            </div>
          </div>
        </div>
        <DialogFooter className="bg-muted/30 px-6 sm:px-7 py-4 border-t border-border/70 flex flex-col-reverse sm:flex-row justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={loading}
            className="rounded-xl font-semibold px-5"
          >
            {cancelText}
          </Button>
          <Button
            type="button"
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={loading}
            className="rounded-xl font-bold px-6"
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
