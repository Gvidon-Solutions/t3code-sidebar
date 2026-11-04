import { expect, it } from "vite-plus/test";
import { validateLayoutEntry, layoutKeyFamilies } from "./registry.ts";
import { merge, type MeshLayoutDocument } from "./document.ts";
import { materialize } from "./materialize.ts";
it("validates every registered family and forwards unknown values without materializing them", () => {
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
  const opaque = { "future/data": { v: { shape: [1, true] }, h: "0000000000000.00000.studio" } };
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
