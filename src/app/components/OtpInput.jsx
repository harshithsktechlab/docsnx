'use client';

import React, { useRef } from 'react';

/**
 * Six single-digit boxes that behave like one field: type to advance, backspace
 * to retreat, paste to fill.
 *
 * Extracted from verify-email/page.js when a tenant admin started needing TWO
 * codes. Inlining it twice would have duplicated the whole contrast argument
 * below along with the focus handling — and the second copy is exactly the one
 * that drifts.
 *
 * ── A CODE BOX HAS TO BE VISIBLE BEFORE IT HOLDS A DIGIT ──────────────────
 * `border-border/80` on `bg-background/60` is invisible in dark: --border is
 * 240 10% 12% and the card it sits on is 240 10% 6%, so the edge measures
 * 1.2:1 and the fill is the card again at 60%. Six empty boxes rendered as six
 * inches of blank card — the member could not tell where to type, or how many
 * digits were wanted.
 *
 * So the surface and the edge are both stated per theme rather than borrowed
 * from tokens tuned for card chrome: a muted fill and a real border in light, a
 * white wash and a white-alpha border in dark, with the border at 2px so it
 * survives at 44px wide.
 *
 * The dark alphas are the measured ones, not eyeballed. A white/20 edge
 * composites to 24.6% grey over the 6% card and lands at 1.8:1 — still blank
 * card on a phone. white/40 composites to ~40.6% and clears 3:1, which is what
 * WCAG asks of a control boundary. The resting fill is white/10; white/6 was
 * 1.15:1, i.e. the card again.
 *
 * `dark:focus:` has to restate the fill because `--field` is 240 10% 12% in
 * dark — DARKER than the resting wash, so the light-mode `focus:bg-field` would
 * dim a focused box instead of lifting it. white/14 is the step up.
 *
 * `h-13` is not a Tailwind class — there is no 13 in the spacing scale and no
 * extension for it in the config — so below the `sm` breakpoint these had NO
 * height at all beyond their line-box, the reset having zeroed padding. h-12 is
 * the real class.
 */
export default function OtpInput({ value, onChange, autoFocus = false, ariaLabel }) {
  const inputRefs = useRef([]);
  const digits = String(value || '').padEnd(6, ' ').slice(0, 6).split('').map((c) => (c === ' ' ? '' : c));

  const setDigit = (index, digit) => {
    const next = [...digits];
    next[index] = digit;
    onChange(next.join('').trim());
  };

  const handleInputChange = (index, raw) => {
    if (!/^\d*$/.test(raw)) return;
    setDigit(index, raw.slice(-1));
    if (raw && index < 5) inputRefs.current[index + 1]?.focus();
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').trim().slice(0, 6);
    if (!/^\d+$/.test(pasted)) return;
    const next = [...digits];
    pasted.split('').forEach((char, idx) => {
      if (idx < 6) next[idx] = char;
    });
    onChange(next.join('').trim());
    inputRefs.current[Math.min(pasted.length, 5)]?.focus();
  };

  return (
    <div
      className="flex items-center justify-center gap-2 sm:gap-3"
      onPaste={handlePaste}
      role="group"
      aria-label={ariaLabel}
    >
      {digits.map((digit, idx) => (
        <input
          key={idx}
          ref={(el) => (inputRefs.current[idx] = el)}
          type="text"
          inputMode="numeric"
          maxLength={1}
          autoFocus={autoFocus && idx === 0}
          value={digit}
          onChange={(e) => handleInputChange(idx, e.target.value)}
          onKeyDown={(e) => handleKeyDown(idx, e)}
          className="w-11 h-12 sm:w-12 sm:h-14 text-center text-xl font-bold rounded-xl text-foreground caret-primary outline-none transition-all shadow-sm border-2 border-border bg-muted/60 dark:border-white/40 dark:bg-white/[0.10] focus:border-primary focus:bg-field dark:focus:border-primary dark:focus:bg-white/[0.14] focus:ring-2 focus:ring-primary/30"
        />
      ))}
    </div>
  );
}
