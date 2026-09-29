import { APP_NAME } from '@/lib/brand';

/**
 * The product name typeset the way the brand kit's wordmark does it: "Docs" in
 * the surrounding text colour, "NX" in the blue→purple→pink brand gradient.
 *
 * Renders inline so it slots into any heading ("Welcome to <BrandWordmark />")
 * and inherits that heading's size and weight. Plain component, no
 * `'use client'`: the gradient is theme-independent, so nothing here needs to
 * know which theme is on screen.
 */
export default function BrandWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={className} aria-label={APP_NAME}>
      Docs<span className="brand-gradient-text">NX</span>
    </span>
  );
}
