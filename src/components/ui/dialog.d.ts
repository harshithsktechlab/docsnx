// Types for dialog.jsx. Without them, `.tsx` callers get the types TypeScript
// infers from the JS file, which make every `className` required and reject
// children on DialogContent.
import type * as React from 'react';
import type * as DialogPrimitive from '@radix-ui/react-dialog';

export const Dialog: typeof DialogPrimitive.Root;
export const DialogPortal: typeof DialogPrimitive.Portal;
export const DialogClose: typeof DialogPrimitive.Close;
export const DialogTrigger: typeof DialogPrimitive.Trigger;
export const DialogOverlay: React.ForwardRefExoticComponent<
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> & React.RefAttributes<HTMLDivElement>
>;
export const DialogContent: React.ForwardRefExoticComponent<
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & React.RefAttributes<HTMLDivElement>
>;
export const DialogTitle: React.ForwardRefExoticComponent<
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title> & React.RefAttributes<HTMLHeadingElement>
>;
export const DialogDescription: React.ForwardRefExoticComponent<
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description> & React.RefAttributes<HTMLParagraphElement>
>;
export const DialogHeader: React.FC<React.HTMLAttributes<HTMLDivElement>>;
export const DialogFooter: React.FC<React.HTMLAttributes<HTMLDivElement>>;
export const DialogBody: React.FC<React.HTMLAttributes<HTMLDivElement>>;
