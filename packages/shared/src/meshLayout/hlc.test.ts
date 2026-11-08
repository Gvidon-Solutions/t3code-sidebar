import { expect, it } from "vite-plus/test";
import { tick, receive, isFutureHlc, MAX_CLOCK_AHEAD_MS } from "./hlc.ts";
it("refuses clock rollback and exhausted counters instead of repeating or reversing a clock", () => {
  const now = 1000;
  const ceiling = `${String(now + MAX_CLOCK_AHEAD_MS).padStart(13, "0")}.99999.studio`;
  expect(() => tick(now, "9999999999999.99999.studio", "studio")).toThrow("clock");
  expect(() => tick(now, ceiling, "studio")).toThrow("clock");
  expect(() => receive(ceiling, "9999999999999.99999.cloudbox", now)).toThrow("clock");
  expect(() => receive(ceiling, ceiling, now)).toThrow("clock");
  expect(isFutureHlc(ceiling, now)).toBe(false);
  expect(isFutureHlc(ceiling, now - 1)).toBe(true);
  const previous = "0000000001000.99999.studio";
  expect(tick(now, previous, "studio")).toBe("0000000001001.00000.studio");
  expect(receive(previous, previous, now)).toBe("0000000001001.00000.studio");
  expect(tick(now - 1, previous, "studio") > previous).toBe(true);
});
