import { expect, it } from "vite-plus/test";
import { merge, type Json, type MeshLayoutDocument } from "../meshLayout/document.ts";
import { validateLayoutEntry } from "../meshLayout/registry.ts";
import { repairMachineIdentity, renameMachineBindings, localMachineClaim } from "./identity.ts";
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

it("retains older bindings when an independent config wins the document register", () => {
  const older = parseConfig({
    schema: 1,
    machines: { cloudbox: { title: "Cloudbox", color: "blue" } },
  });
  const document: MeshLayoutDocument = {
    ...join("alpha"),
    "mesh.machineBinding/cloudbox": { v: "cloud", h },
    "mesh.configHistory/older": {
      v: { revision: "older", author: "cloud", writtenAt: "", doc: older } as Json,
      h,
    },
  };
  const result = repairMachineIdentity(document, config);
  expect(result.updates["mesh.machineBinding/cloudbox"]).toBeUndefined();
  expect(result.doc.machines.cloudbox).toEqual({ title: "Cloudbox", color: "blue" });
  expect(result.updates["mesh.machineClaim/cloud"]).toEqual({
    name: "cloudbox",
    machine: older.machines.cloudbox,
  });
});

it("claims a local identity before replication, including an older bound installation", () => {
  const current = {
    v: { revision: "one", author: "alpha", writtenAt: "", doc: config } as Json,
    h,
  };
  const bound = { "mesh.config": current, "mesh.machineBinding/studio": { v: "alpha", h } };
  expect(
    localMachineClaim(bound, { environmentId: "alpha", label: "different hostname" }, h)[
      "mesh.machineClaim/alpha"
    ]?.v,
  ).toEqual({ name: "studio", machine: { title: "Studio" } });
  expect(
    localMachineClaim(bound, { environmentId: "beta", label: "Studio" }, h)[
      "mesh.machineClaim/beta"
    ]?.v,
  ).toEqual({ name: "studio", machine: { title: "Studio" } });
  expect(localMachineClaim(join("alpha"), { environmentId: "alpha", label: "Studio" }, h)).toEqual(
    {},
  );
});

it("keeps the configured settings when a machine first binds a reserved config name", () => {
  const desired = parseConfig({
    schema: 1,
    machines: { studio: { title: "Studio", label: "ST", color: "blue" } },
  });
  const document: MeshLayoutDocument = {
    "mesh.machineClaim/alpha": join("alpha")["mesh.machineClaim/alpha"]!,
  };
  expect(repairMachineIdentity(document, desired).doc.machines.studio).toEqual(
    desired.machines.studio,
  );
});

it("binds a bootstrapped identity to its configured name after provisional peer facts arrive", () => {
  const machine = { title: "Cloudbox", bootstrap: { ssh: "root@cloudbox" } };
  const doc = parseConfig({
    schema: 1,
    machines: { provisional: { title: "temporary hostname" }, cloudbox: machine },
  });
  const document: MeshLayoutDocument = {
    "mesh.machineBinding/provisional": { h, v: "cloud-id" },
    "mesh.machineBinding/cloudbox": { h, v: "cloud-id" },
    "mesh.machineClaim/cloud-id": { h, v: { name: "cloudbox", machine } },
    "mesh.bootstrapOwner/cloudbox": { h, v: "studio-id" },
  };
  const result = repairMachineIdentity(document, doc);
  expect(result.updates["mesh.machineBinding/provisional"]).toBeNull();
  expect(result.doc.machines).toEqual({ cloudbox: machine });
});
