import { expect, it } from "vite-plus/test";
import { merge, type MeshLayoutDocument } from "../meshLayout/document.ts";
import { validateLayoutEntry } from "../meshLayout/registry.ts";
import { repairMachineIdentity, renameMachineBindings } from "./identity.ts";
import { parseConfig } from "./index.ts";

const config = parseConfig({ schema: 1, machines: { studio: { title: "Studio" } } });
const h = "0000000000001.00000.studio";
const join = (id: string): MeshLayoutDocument => ({
  "mesh.machineBinding/studio": { v: id, h },
  [`mesh.machineClaim/${id}`]: { v: { name: "studio", machine: { title: "Studio" } }, h },
});
it.each([
  ["alpha", "beta"],
  ["beta", "alpha"],
])("converges concurrent joins through registry and CRDT (%s, %s)", (a, b) => {
  const left = join(a);
  const right = join(b);
  for (const document of [left, right])
    for (const [key, entry] of Object.entries(document))
      expect(validateLayoutEntry(key, entry)).toBeNull();
  const result = repairMachineIdentity(merge(left, right), config);
  expect(result.updates["mesh.machineBinding/studio-2"]).toBe("beta");
  const fixed = merge(
    merge(left, right),
    Object.fromEntries(
      Object.entries(result.updates).map(([key, v]) => [
        key,
        { v, h: "0000000000002.00000.studio" },
      ]),
    ),
  );
  expect(fixed["mesh.machineBinding/studio"]?.v).toBe("alpha");
  expect(repairMachineIdentity(fixed, result.doc).changed).toBe(false);
  expect(Object.keys(result.doc.machines).sort()).toEqual(["studio", "studio-2"]);
});
it("repairs an unbound reported environment without taking the existing binding", () => {
  const document = { ...join("alpha"), "machine/beta": { v: { title: "Studio" }, h } };
  const result = repairMachineIdentity(document, config);
  expect(result.updates["mesh.machineBinding/studio"]).toBeUndefined();
  expect(result.updates["mesh.machineBinding/studio-2"]).toBe("beta");
});
it("moves binding and durable claim when the config key is renamed", () => {
  const next = parseConfig({ schema: 1, machines: { laptop: { title: "Studio" } } });
  expect(renameMachineBindings(join("alpha"), config, next)).toEqual({
    "mesh.machineBinding/studio": null,
    "mesh.machineBinding/laptop": "alpha",
    "mesh.machineClaim/alpha": { name: "laptop", machine: { title: "Studio" } },
  });
});

it("keeps explicitly removed machines removed across reconciliation", () => {
  const after = parseConfig({ schema: 1, machines: {} });
  const entries = renameMachineBindings(join("alpha"), config, after);
  const document = merge(
    join("alpha"),
    Object.fromEntries(
      Object.entries(entries).map(([key, v]) => [key, { v, h: "0000000000002.00000.studio" }]),
    ),
  );
  expect(repairMachineIdentity(document, after).changed).toBe(false);
});
