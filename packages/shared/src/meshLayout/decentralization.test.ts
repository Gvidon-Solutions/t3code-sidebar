import { expect, it } from "@effect/vitest";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty } from "@t3tools/contracts";
import { materialize } from "./materialize.ts";
import { adoptLegacy } from "./migration/adoptLegacy.ts";
import { conflictWinner } from "../meshConfig/index.ts";
import { recordLayoutAuthors } from "./authorship.ts";
it("ignores old authority entries and resolves duplicate claims deterministically by clock", () => {
  const rep = {
    environmentId: "studio",
    path: "/app",
    role: "primary",
    transport: "git",
    createdAt: "",
  };
  const authored = recordLayoutAuthors(
    { "rep/b/studio": { v: rep, h: "0000000000001.00000.browser" } },
    "old",
  );
  const document = {
    ...authored,
    "mesh.authority": { v: "old", h: "0000000000009.00000.old" },
    "rep/a/studio": { v: rep, h: "0000000000003.00000.laptop" },
  };
  const config = materialize(document);
  expect(config).not.toHaveProperty("meshAuthority");
  expect(config.projectMounts.a).toHaveLength(1);
  expect(config.projectMounts.b).toEqual([]);
  expect(materialize(Object.fromEntries(Object.entries(document).reverse()))).toEqual(config);
  expect(recordLayoutAuthors(authored, "old")).toEqual(authored);
});
it("adopts duplicate legacy workspace names with a stable id regardless of old authority", () => {
  const document = {
    "mesh.authority": { v: "old", h: "0000000000009.00000.old" },
    "ws/z": { v: { name: "Main", sort: "V" }, h: "0000000000000.00000.old" },
    "ws/a": { v: { name: "Main", sort: "V" }, h: "0000000000000.00000.laptop" },
  };
  expect(materialize(adoptLegacy(empty, document)).workspaces.map((w) => w.id)).toEqual(["a"]);
});
it("uses project conflict policy and breaks equal modification times toward the primary", () => {
  expect(conflictWinner("primary-wins", 1, 2)).toBe("alpha");
  expect(conflictWinner("newest-wins", 1, 2)).toBe("beta");
  expect(conflictWinner("newest-wins", 2, 2)).toBe("alpha");
  expect(conflictWinner("newest-wins", 3, 2)).toBe("alpha");
});
