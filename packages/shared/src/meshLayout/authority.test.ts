import { adoptLegacy } from "./adoptLegacy.ts";
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty } from "@t3tools/contracts";
import { conflictWinner, meshAuthorityOf } from "./authority.ts";
import { materialize } from "./materialize.ts";
import { diff } from "./diff.ts";

describe("mesh authority", () => {
  it("uses the lowest writer, independently of machine labels or insertion order", () => {
    expect(meshAuthorityOf(empty)).toBeUndefined();
    expect(meshAuthorityOf({ ...empty, meshWriters: ["z", "b", "a"] })).toBe("a");
    const config = materialize({
      "machine/z": { v: { label: "gvidon" }, h: "0000000000001.00000.b" },
      "writer/a": { v: true, h: "0000000000002.00000.a" },
      "writer/b": { v: true, h: "0000000000001.00000.b" },
    });
    expect(meshAuthorityOf(config)).toBe("a");
    const edit = diff(config, { ...config, meshAuthority: "z" }, {}, "0000000000003.00000.b");
    expect(edit["mesh.authority"]?.v).toBe("z");
    expect(meshAuthorityOf(materialize(edit))).toBe("z");
  });
  it("chooses authority when present, otherwise the primary, on either driver", () => {
    for (const [authority, expected] of [
      ["primary", "alpha"],
      ["replica", "beta"],
      ["elsewhere", "alpha"],
    ] as const) {
      expect(conflictWinner({ ...empty, meshAuthority: authority }, "primary", "replica")).toBe(
        expected,
      );
    }
    expect(conflictWinner({ ...empty, meshWriters: ["replica"] }, "primary", "replica")).toBe(
      "beta",
    );
  });
});

it("assigns a normalized machine/path to only one project, preferring an authority-authored claim", () => {
  const rep = {
    environmentId: "host",
    path: "/repo/child/.././",
    role: "primary",
    transport: "git",
    createdAt: "",
  };
  const doc = {
    "mesh.authority": { v: "authority", h: "0000000000009.00000.other" },
    "rep/a/host": { v: rep, h: "0000000000008.00000.other" },
    "rep/z/host": { v: { ...rep, path: "/repo" }, h: "0000000000001.00000.authority" },
  } as const;
  expect(materialize(doc).projectMounts.a).toEqual([]);
  expect(materialize(doc).projectMounts.z).toHaveLength(1);
  expect(materialize(Object.fromEntries(Object.entries(doc).reverse()))).toEqual(materialize(doc));
});

it("adopts ambiguous legacy workspace names in favour of the authority's id and remaps placements", () => {
  const doc = {
    "mesh.authority": { v: "owner", h: "0000000000001.00000.owner" },
    "ws/z": { v: { name: "Main", sort: "V" }, h: "0000000000000.00000.owner" },
    "ws/a": { v: { name: "Main", sort: "V" }, h: "0000000000000.00000.peer" },
    "place/project/a": { v: { sort: "V" }, h: "0000000000000.00000.peer" },
  } as const;
  const config = materialize(adoptLegacy(empty, doc));
  expect(config.workspaces.map((w) => w.id)).toEqual(["z"]);
  expect(config.placements.project).toEqual(["z"]);
  expect(config.meshAuthority).toBe("owner");
});
