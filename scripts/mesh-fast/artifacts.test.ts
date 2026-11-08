// @effect-diagnostics nodeBuiltinImport:off - Verifies isolated artifact filesystem cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { prunePassed } from "./artifacts.mjs";

it("prunes passed machine payloads while preserving diagnostics and unowned or linked data", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-artifacts-"));
  try {
    const scenario = NodePath.join(root, "case"),
      machine = NodePath.join(scenario, "studio"),
      outside = NodePath.join(root, "outside");
    await NodeFSP.mkdir(machine, { recursive: true });
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(NodePath.join(outside, "retained"), "owner data");
    await NodeFSP.writeFile(NodePath.join(machine, "server-spec.json"), "{}");
    await NodeFSP.writeFile(NodePath.join(machine, "server.log"), "diagnostics");
    await NodeFSP.symlink(outside, NodePath.join(machine, "home"));
    for (const payload of ["state", "runtime"]) {
      await NodeFSP.mkdir(NodePath.join(machine, payload));
      await NodeFSP.writeFile(NodePath.join(machine, payload, "data"), "private fixture data");
    }
    await NodeFSP.mkdir(NodePath.join(scenario, "unmarked", "state"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(scenario, "unmarked", "state", "data"), "retained");
    await NodeFSP.symlink(outside, NodePath.join(scenario, "linked"));
    await NodeFSP.mkdir(NodePath.join(scenario, "artifacts"));
    await NodeFSP.writeFile(NodePath.join(scenario, "artifacts", "shot.png"), "evidence");
    await prunePassed(scenario);
    for (const payload of ["home", "state", "runtime"])
      await expect(NodeFSP.lstat(NodePath.join(machine, payload))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(await NodeFSP.readFile(NodePath.join(machine, "server.log"), "utf8")).toBe(
      "diagnostics",
    );
    expect(await NodeFSP.readFile(NodePath.join(outside, "retained"), "utf8")).toBe("owner data");
    expect(
      await NodeFSP.readFile(NodePath.join(scenario, "unmarked", "state", "data"), "utf8"),
    ).toBe("retained");
    expect(await NodeFSP.readFile(NodePath.join(scenario, "artifacts", "shot.png"), "utf8")).toBe(
      "evidence",
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
