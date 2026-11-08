import { SidebarWorkspacesConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const isConfig = Schema.is(SidebarWorkspacesConfig);
const decodeConfig = Schema.decodeSync(SidebarWorkspacesConfig);
import { expect, it } from "vite-plus/test";
import { validateLayoutEntry, layoutKeyFamilies } from "./registry.ts";
import { merge, type MeshLayoutDocument } from "./document.ts";
import { materialize } from "./materialize.ts";
it("validates every registered family and forwards unknown values without materializing them", () => {
  const futureMachine = {
    "machine/studio": {
      v: { label: "Studio", futureFacts: { version: "future" } },
      h: "0000000000000.00000.studio",
    },
  };
  const forwardedMachine = merge({}, futureMachine);
  expect(forwardedMachine).toEqual(futureMachine);
  expect(materialize(forwardedMachine).machines.studio).toEqual({ label: "Studio" });
  expect(decodeConfig(materialize(forwardedMachine))).toEqual(materialize(forwardedMachine));
  for (const key of Object.keys(layoutKeyFamilies)) {
    const name = [
      key,
      ...Array.from(
        { length: layoutKeyFamilies[key as keyof typeof layoutKeyFamilies].segments - 1 },
        () => "id",
      ),
    ].join("/");
    expect(validateLayoutEntry(name, { v: null, h: "0000000000000.00000.studio" })).toBeNull();
    expect(
      validateLayoutEntry(name, { v: key === "legacy" ? {} : [], h: "0000000000000.00000.studio" }),
    ).not.toBeNull();
  }
  expect(
    validateLayoutEntry("ws/blank", {
      v: { name: "  ", sort: "a0" },
      h: "0000000000000.00000.studio",
    }),
  ).not.toBeNull();
  expect(
    validateLayoutEntry("rule/blank", {
      v: { match: "", workspace: "main", sort: "a0" },
      h: "0000000000000.00000.studio",
    }),
  ).not.toBeNull();
  expect(
    validateLayoutEntry("ws/%20", {
      v: { name: "Main", sort: "a0" },
      h: "0000000000000.00000.studio",
    }),
  ).not.toBeNull();
  expect(
    isConfig(
      materialize({
        "ws/main": { v: { name: "Main", sort: "a0", id: 123 }, h: "0000000000000.00000.studio" },
        "order/example": { v: { sort: "a0", id: 123 }, h: "0000000000000.00000.studio" },
        "place/example/main": {
          v: { sort: "a0", workspace: 123, project: 123 },
          h: "0000000000000.00000.studio",
        },
      }),
    ),
  ).toBe(true);
  expect(
    isConfig(
      materialize({
        "rep/__proto__/studio": {
          v: {
            environmentId: "studio",
            path: "/project",
            transport: "git",
            role: "primary",
            createdAt: "",
          },
          h: "0000000000000.00000.studio",
        },
        "place/__proto__/constructor": { v: { sort: "a0" }, h: "0000000000000.00000.studio" },
        "fold/constructor/__proto__": { v: "quiet", h: "0000000000000.00000.studio" },
      }),
    ),
  ).toBe(true);
  const revision = {
    revision: "revision",
    author: "studio",
    writtenAt: "",
    doc: {
      schema: 1,
      machines: { studio: { label: "Studio", future: true } },
      future: { retained: true },
    },
  };
  for (const key of ["mesh.config", "mesh.configHistory/revision"]) {
    expect(validateLayoutEntry(key, { v: revision, h: "0000000000000.00000.studio" })).toBeNull();
    for (const doc of [
      false,
      { schema: 1, machines: { studio: { label: 12 } } },
      { schema: 1, machines: { "not a slug": {} } },
      {
        schema: 1,
        machines: {},
        replicas: { rules: [{ project: "example", on: "studio", when: "unknown" }] },
      },
    ]) {
      expect(
        validateLayoutEntry(key, { v: { ...revision, doc }, h: "0000000000000.00000.studio" }),
      ).not.toBeNull();
    }
  }
  const opaque = { "future/data": { v: { shape: [1, true] }, h: "0000000000000.00000.studio" } };
  for (const [key, value] of Object.entries({
    "mesh.machineBinding/studio": "studio-env",
    "mesh.configStatus/studio-env": { environmentId: "studio-env", revision: null, actions: [] },
    "mesh.configReplica/project/studio-env": true,
    "mesh.linkPolicy/studio-env/laptop": { files: "projects", replicas: true, threads: false },
  }))
    expect(validateLayoutEntry(key, { v: value, h: "0000000000000.00000.studio" })).toBeNull();
  for (const [key, value] of [
    ["mesh.machineBinding/Bad Name", "studio-env"],
    ["mesh.machineBinding/studio", "  "],
    ["mesh.configStatus/studio-env", { environmentId: "studio-env" }],
    ["mesh.configReplica/project/studio-env", "true"],
    ["mesh.linkPolicy/studio-env/laptop", { files: "root" }],
  ] as const)
    expect(validateLayoutEntry(key, { v: value, h: "0000000000000.00000.studio" })).not.toBeNull();
  expect(validateLayoutEntry("future/data", opaque["future/data"])).toBeNull();
  expect(merge({}, opaque)).toEqual(opaque);
  expect(materialize(opaque)).toEqual(materialize({}));
});
it("converges under random three-replica interleaving, duplication and reordering", () => {
  let seed = 71;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let trial = 0; trial < 100; trial++) {
    const replicas: MeshLayoutDocument[] = [{}, {}, {}];
    const deliveries: MeshLayoutDocument[] = [];
    for (let i = 0; i < 100; i++) {
      const replica = random() % 3;
      const entry = {
        [`proj/project-${random() % 8}.title`]: {
          v: random() % 5 === 0 ? null : `Title ${random()}`,
          h: `${String(random() % 20).padStart(13, "0")}.00000.${replica}`,
        },
      };
      replicas[replica] = merge(replicas[replica]!, entry);
      deliveries.push(entry);
      replicas[random() % 3] = merge(replicas[random() % 3]!, entry);
    }
    for (let r = 0; r < 3; r++) {
      const shuffled = deliveries
        .map((entry) => ({ entry, order: random() }))
        .sort((a, b) => a.order - b.order);
      for (const { entry } of shuffled) replicas[r] = merge(merge(replicas[r]!, entry), entry);
    }
    expect(materialize(replicas[0]!)).toEqual(materialize(replicas[1]!));
    expect(replicas[0]).toEqual(replicas[2]);
  }
});
it("rejects noncanonical keys and mismatched representation identities before materialization", () => {
  const h = "0000000000000.00000.studio";
  const rep = {
    environmentId: "studio",
    path: "/work",
    transport: "git",
    role: "primary",
    createdAt: "",
  };
  for (const key of ["rep/p/cloudbox", "rep/%70/studio", "rep/p/%73tudio"]) {
    expect(validateLayoutEntry(key, { v: rep, h })).not.toBeNull();
    expect(() => materialize({ [key]: { v: rep, h } })).not.toThrow();
  }
  let seed = 19;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const segments = ["studio", "%73tudio", "%", "a%2fb", "a%2Fb", "__proto__", "a.b"];
  for (let i = 0; i < 1000; i++) {
    const key = `rep/${segments[random() % segments.length]}/${segments[random() % segments.length]}`;
    const document = { [key]: { v: rep, h } };
    expect(() => materialize(document)).not.toThrow();
  }
});
it("ignores invalid scalar settings and deleted or malformed writers", () => {
  const h = "0000000000000.00000.studio";
  expect(
    materialize({
      "ws.default": { v: 12, h },
      "ws.quietAfterDays": { v: -1, h },
      "writer/studio": { v: null, h },
      "writer/%": { v: true, h },
    }),
  ).toMatchObject({ defaultWorkspace: null, quietAfterDays: 5 });
  expect(materialize({ "writer/studio": { v: null, h } }).meshWriters).toBeUndefined();
});
it("orders competing representation claims by HLC bytes independently of locale", () => {
  const v = {
    environmentId: "studio",
    path: "/work",
    transport: "git",
    role: "primary",
    createdAt: "",
  };
  const config = materialize({
    "rep/p/studio": { v, h: "0000000000001.00000.Z" },
    "rep/q/studio": { v, h: "0000000000001.00000.a" },
  });
  expect(config.projectMounts.p).toEqual([]);
  expect(config.projectMounts.q).toEqual([v]);
});
