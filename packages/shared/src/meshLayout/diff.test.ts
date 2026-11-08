import { expect, it } from "vite-plus/test";
import { diff } from "./diff.ts";
import { materialize } from "./materialize.ts";
import { merge } from "./document.ts";

it.each([false, true])(
  "preserves a concurrent workspace rename while repairing sort collisions: %s",
  (collision) => {
    const original = {
      "ws/alpha": {
        v: { name: "Alpha", sort: "a1" },
        h: "0000000000001.00000.studio",
      },
      "ws/beta": {
        v: { name: "Beta", sort: collision ? "a1" : "a2" },
        h: "0000000000001.00000.studio",
      },
    };
    const before = materialize(original);
    const current = merge(original, {
      "ws/beta": {
        v: { ...original["ws/beta"].v, name: "Renamed on cloudbox" },
        h: "0000000000002.00000.cloudbox",
      },
    });
    const entries = diff(
      before,
      {
        ...before,
        workspaces: before.workspaces.map((workspace) =>
          workspace.id === "alpha" ? { ...workspace, name: "Renamed on studio" } : workspace,
        ),
      },
      current,
      "0000000000003.00000.studio",
    );
    const merged = merge(current, entries);
    expect(materialize(merged).workspaces).toEqual([
      { id: "alpha", name: "Renamed on studio" },
      { id: "beta", name: "Renamed on cloudbox" },
    ]);
    if (collision) expect(merged["ws/beta"]?.v).not.toEqual(current["ws/beta"]?.v);
    else expect(entries).not.toHaveProperty("ws/beta");
  },
);
