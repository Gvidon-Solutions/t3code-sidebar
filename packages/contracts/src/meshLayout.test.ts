import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { MeshLayoutEntry } from "./meshLayout.ts";
it("rejects malformed layout clocks at the wire boundary", () => {
  const decode = Schema.decodeUnknownSync(MeshLayoutEntry);
  for (const h of ["", "1.0.studio", "0000000000000.00000.", "0000000000000.000000.studio"]) {
    expect(() => decode({ v: true, h })).toThrow();
  }
  expect(decode({ v: true, h: "0000000000000.00000.studio" }).h).toBe("0000000000000.00000.studio");
});
