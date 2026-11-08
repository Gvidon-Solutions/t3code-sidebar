import { expect, it } from "vite-plus/test";
import { resolveAlias } from "./resolveAlias.ts";
it("resolves long chains and only considers cycle members for the canonical id", () => {
  const aliases = { a: "z", z: "y", y: "z", self: "self" };
  for (const key of ["a", "y", "z"]) expect(resolveAlias(aliases, key)).toBe("y");
  expect(resolveAlias(aliases, "self")).toBe("self");
  expect(resolveAlias({}, "__proto__")).toBe("__proto__");
  const chain = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${i}`, `p${i + 1}`]));
  expect(resolveAlias(chain, "p0")).toBe("p100");
});
