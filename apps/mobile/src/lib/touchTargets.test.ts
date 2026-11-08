import { describe, expect, it } from "vite-plus/test";
import { boxHitSlop, MIN_TOUCH_TARGET, verticalHitSlop } from "./touchTargets";

describe("touch targets", () => {
  it("brings compact visual rows to at least 44-48 dp", () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [32, verticalHitSlop(32).top],
      [28, verticalHitSlop(28).top],
      [24, verticalHitSlop(24).top],
      [20, verticalHitSlop(20).top],
    ];
    for (const [visual, pad] of cases) {
      expect(visual + pad * 2).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(visual + pad * 2).toBeLessThanOrEqual(MIN_TOUCH_TARGET + 2);
    }
  });
  it("brings square icon buttons to the minimum on every side", () => {
    const slop = boxHitSlop(28);
    expect(28 + slop.left + slop.right).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    expect(28 + slop.top + slop.bottom).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    expect(boxHitSlop(48)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });
});
