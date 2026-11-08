/** Android's recommended minimum touch target, in dp. */
export const MIN_TOUCH_TARGET = 48;

export interface HitSlop {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

function padFor(visualSize: number, target: number): number {
  if (!Number.isFinite(visualSize)) return 0;
  return Math.max(0, Math.ceil((target - visualSize) / 2));
}

/**
 * Padding that brings a visually compact row up to the minimum touch height
 * without changing its density. Width is inherited from the row.
 */
export function verticalHitSlop(visualHeight: number, target: number = MIN_TOUCH_TARGET): HitSlop {
  const pad = padFor(visualHeight, target);
  return { top: pad, bottom: pad, left: 0, right: 0 };
}

/** Padding that brings a square icon button up to the minimum touch target. */
export function boxHitSlop(visualSize: number, target: number = MIN_TOUCH_TARGET): HitSlop {
  const pad = padFor(visualSize, target);
  return { top: pad, bottom: pad, left: pad, right: pad };
}
