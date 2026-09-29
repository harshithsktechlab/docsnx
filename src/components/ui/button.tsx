import React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // The literal blue these two carried is not `--primary` (a violet) and
        // never was — tracking the token keeps the glow under the button the
        // same colour as the button.
        default:
          'bg-primary text-primary-foreground shadow-[0_4px_16px_hsl(var(--primary)/0.35)] hover:brightness-105 hover:shadow-[0_6px_24px_hsl(var(--primary)/0.45)] active:translate-y-px',
        destructive:
          'bg-destructive text-destructive-foreground shadow-[0_4px_12px_hsl(var(--danger-solid)/0.3)] hover:brightness-105',
        // `bg-card`, not `bg-transparent`: on the tinted canvas a transparent
        // outline button reads as a hole rather than a control. On a card it is
        // the same white it always was.
        outline:
          'border border-border bg-card hover:bg-muted hover:text-foreground',
        secondary:
          'bg-muted border border-border text-foreground hover:bg-muted/80 hover:border-border/80',
        ghost: 'hover:bg-muted hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        success:
          'bg-success text-success-foreground shadow-[0_4px_12px_hsl(var(--success-solid)/0.3)] hover:brightness-105',
      },
      size: {
        default: 'h-10 px-5 py-2',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-12 rounded-xl px-8 text-base',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
