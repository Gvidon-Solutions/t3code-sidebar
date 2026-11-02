import { expect, it } from "@effect/vitest";
import { SidebarWorkspacesConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import gvidon from "../../../client-runtime/src/state/meshLayout/fixtures/gvidon.json" with { type: "json" };
import operalia from "../../../client-runtime/src/state/meshLayout/fixtures/operalia.json" with { type: "json" };
import { adoptLegacy, importLegacy, materialize } from "./index.ts";

it.each([
  [gvidon, operalia],
  [operalia, gvidon],
])(
  "unifies legacy workspace names and keeps every placement in either join order",
  (first, second) => {
    const a = decodeConfig(first);
    const b = decodeConfig(second);
    const result = materialize(
      adoptLegacy(b, importLegacy(a, "first", "0000000000000.00000.first")),
    );
    expect(result.workspaces.filter((w) => w.name === "main")).toEqual([
      expect.objectContaining({ id: "main", name: "main" }),
    ]);
    for (const source of [a, b])
      for (const [project, placements] of Object.entries(source.placements)) {
        for (const id of placements) {
          const name = source.workspaces.find((w) => w.id === id)?.name;
          const target = result.workspaces.find((w) => w.name === name)?.id ?? id;
          expect(result.placements[project]).toContain(target);
        }
      }
  },
);

const decodeConfig = Schema.decodeUnknownSync(SidebarWorkspacesConfig);
