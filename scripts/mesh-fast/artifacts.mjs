import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { run } from "./client.mjs";

export async function prunePassed(directory) {
  const payloads = [];
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const machine = NodePath.join(directory, entry.name);
    let owned = false;
    for (const marker of ["server-spec.json", ".mesh-fast-node"]) {
      try {
        await NodeFSP.stat(NodePath.join(machine, marker));
        owned = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (owned)
      for (const payload of ["home", "state", "runtime"])
        payloads.push(NodePath.join(machine, payload));
  }
  if (payloads.length) await run("rm", ["-rf", "--", ...payloads]);
}
