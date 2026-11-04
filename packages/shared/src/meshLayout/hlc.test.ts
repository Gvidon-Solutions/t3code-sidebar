import { expect, it } from "vite-plus/test";
import { tick, receive, isFutureHlc, MAX_CLOCK_AHEAD_MS } from "./hlc.ts";
it("bounds generation after clock rollback, poisoned state and counter overflow", () => {
  const now = 1000;
  const ceiling = `${String(now + MAX_CLOCK_AHEAD_MS).padStart(13, "0")}.99999.studio`;
  expect(isFutureHlc(tick(now, "9999999999999.99999.studio", "studio"), now)).toBe(false);
  expect(isFutureHlc(tick(now, ceiling, "studio"), now)).toBe(false);
  expect(isFutureHlc(receive(ceiling, "9999999999999.99999.cloudbox", now), now)).toBe(false);
  expect(isFutureHlc(ceiling, now)).toBe(false);
  expect(isFutureHlc(ceiling, now - 1)).toBe(true);
});
