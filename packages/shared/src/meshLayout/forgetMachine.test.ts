import { expect, it } from "vite-plus/test";
import { diff, materialize, merge, type MeshLayoutDocument } from "./index.ts";

it("forgets the binding as well as reported machine facts without changing desired config", () => {
  const h = "0000000000001.00000.studio";
  const doc: MeshLayoutDocument = {
    "mesh.config": {
      h,
      v: {
        revision: "one",
        author: "studio",
        writtenAt: "2026-11-05T00:00:00Z",
        doc: { schema: 1, machines: { cloudbox: { label: "CB" } } },
      },
    },
    "mesh.machineBinding/cloudbox": { h, v: "old" },
    "mesh.machineClaim/old": { h, v: { name: "cloudbox", machine: { label: "CB" } } },
    "machine/old": { h, v: { label: "Old" } },
  };
  const before = materialize(doc);
  const after = { ...before, machines: {} };
  const next = merge(doc, diff(before, after, doc, "0000000000002.00000.studio"));
  expect(materialize(next).machines).toEqual({});
  expect(next["mesh.machineBinding/cloudbox"]?.v).toBeNull();
  expect(next["mesh.machineClaim/old"]?.v).toBeNull();
  expect(next["mesh.config"]).toEqual(doc["mesh.config"]);
});
