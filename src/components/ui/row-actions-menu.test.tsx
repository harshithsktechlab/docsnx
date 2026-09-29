/**
 * The ⋮ row menu used to be a `position: absolute` panel, which the DataTable's
 * `overflow-hidden` wrapper clipped away entirely on the LAST row of every file
 * list. It is now a portal anchored by `anchorMenu`, so these are the cases that
 * bug was: a trigger with no room below it, and a trigger near a viewport edge.
 */
import { describe, it, expect } from 'vitest';
import { anchorMenu } from './row-actions-menu';

const WIDTH = 144;
const VIEWPORT = { width: 1280, height: 800 };

/** A trigger rect, given its top-left corner. Triggers are the 32px icon button. */
const trigger = (left: number, top: number) => ({
  left, top, right: left + 32, bottom: top + 32,
} as DOMRect);

describe('anchorMenu', () => {
  it('right-aligns the panel to the trigger', () => {
    const t = trigger(600, 200);
    const { left } = anchorMenu(t, 120, VIEWPORT);
    expect(left + WIDTH).toBe(t.right);
  });

  it('opens below the trigger when there is room', () => {
    const t = trigger(600, 200);
    expect(anchorMenu(t, 120, VIEWPORT).top).toBe(t.bottom + 4);
  });

  it('flips above the trigger when the panel would not fit below', () => {
    // The reported bug: the last row of a full list, near the bottom edge.
    const t = trigger(600, 760);
    const { top } = anchorMenu(t, 120, VIEWPORT);
    expect(top).toBe(t.top - 120 - 4);
    expect(top + 120).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('pins to the top when the panel fits neither below nor above', () => {
    // A short viewport (a phone in landscape) and a five-item menu.
    const t = trigger(600, 200);
    const { top } = anchorMenu(t, 400, { width: 1280, height: 420 });
    expect(top).toBe(8);
  });

  it('never runs off the right edge', () => {
    const t = trigger(VIEWPORT.width - 20, 200);
    const { left } = anchorMenu(t, 120, VIEWPORT);
    expect(left + WIDTH).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });

  it('never runs off the left edge on a narrow viewport', () => {
    const t = trigger(10, 200);
    const { left } = anchorMenu(t, 120, { width: 320, height: 800 });
    expect(left).toBeGreaterThanOrEqual(8);
  });

  it('right-aligns and clamps a wider panel too', () => {
    // The workspace switcher hangs a 240px panel off a header chip. Same rule,
    // one number — a second anchoring function is what this parameter avoids.
    const WIDE = 240;
    const t = trigger(600, 40);
    expect(anchorMenu(t, 160, VIEWPORT, WIDE).left + WIDE).toBe(t.right);

    const nearEdge = trigger(VIEWPORT.width - 20, 40);
    const { left } = anchorMenu(nearEdge, 160, VIEWPORT, WIDE);
    expect(left + WIDE).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });
});
