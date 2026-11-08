import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import { ownership, labelArgs, recoverStale } from "./lifecycle.mjs";
import { run, until } from "./client.mjs";
import { allocatePort } from "./mesh.mjs";
import { containerBoot } from "./boot.mjs";
import { harnessRoot } from "./paths.mjs";

export async function recoveryScenario(directory) {
  const owner = await ownership();
  const previous = { ...owner, boot: NodeCrypto.randomUUID(), runId: NodeCrypto.randomUUID() };
  const name = "mesh-fast-recovery-" + NodeCrypto.randomUUID();
  const containers = [];
  let network;
  const port = await allocatePort();
  const listener = NodeNet.createServer();
  try {
    network = await run("docker", ["network", "create", ...labelArgs(previous), name]);
    const launch = async (suffix, options) => {
      const id = await containerBoot(() =>
        run("docker", [
          "run",
          "-d",
          "--name",
          name + suffix,
          ...options,
          "mesh-fast-node:26",
          "node",
          "-e",
          'require("http").createServer((q,s)=>s.end("ready")).listen(8080,"0.0.0.0")',
        ]),
      );
      containers.push(id);
      return id;
    };
    const abandoned = await launch("-old", [
      ...labelArgs(previous),
      "--restart=always",
      "--network",
      network,
      "-p",
      `127.0.0.1:${port}:8080`,
    ]);
    await until(
      "previous boot owns its published port",
      () => fetch(`http://127.0.0.1:${port}`).then((r) => r.text()),
      (value) => value === "ready",
    );
    const live = await launch("-active", [
      ...labelArgs(owner),
      "--restart=no",
      "--network",
      "none",
    ]);
    const foreign = await launch("-foreign", ["--restart=no", "--network", network]);
    await NodeAssert.rejects(recoverStale(owner), /active or unowned attachment/);
    NodeAssert.equal(
      JSON.parse(await run("docker", ["inspect", abandoned]))[0].State.Running,
      true,
    );
    await run("docker", ["network", "disconnect", network, foreign]);
    const reused = await launch("-reused-pid", [
      ...labelArgs({ ...owner, start: "0", runId: NodeCrypto.randomUUID() }),
      "--restart=no",
      "--network",
      "none",
    ]);
    const parentOutput = NodePath.join(directory, "parent-github-output");
    await NodeFSP.writeFile(parentOutput, "artifacts=parent-only\n");
    const childEnvironment = {
      ...process.env,
      MESH_FAST_STATE_DIR: NodePath.join(directory, "admission"),
      GITHUB_OUTPUT: parentOutput,
    };
    delete childEnvironment.GITHUB_OUTPUT;
    const nextCommand = await run(
      "bash",
      [NodePath.join(harnessRoot, "scripts/mesh-fast/run.sh"), "--scenario", "runner-cancel-boot"],
      { env: childEnvironment },
    );
    NodeAssert.equal(
      await NodeFSP.readFile(parentOutput, "utf8"),
      "artifacts=parent-only\n",
      "nested recovery must preserve the parent Actions artifact output",
    );
    await NodeFSP.writeFile(NodePath.join(directory, "next-command.log"), nextCommand);
    const nextArtifacts = nextCommand.match(/^Artifacts: (.+)$/m)?.[1];
    NodeAssert.ok(nextArtifacts, "next real command produced its artifact directory");
    const recovered = JSON.parse(
      await NodeFSP.readFile(NodePath.join(nextArtifacts, "recovery.json"), "utf8"),
    );
    NodeAssert.deepEqual(
      new Set(recovered.containers.map((c) => c.id)),
      new Set([abandoned, reused]),
    );
    NodeAssert.deepEqual(
      recovered.networks.map((n) => n.id),
      [network],
    );
    for (const id of [live, foreign])
      NodeAssert.equal(JSON.parse(await run("docker", ["inspect", id]))[0].State.Running, true);
    listener.listen(port, "127.0.0.1");
    await NodeEvents.once(listener, "listening");
    NodeAssert.equal(process.pid, owner.pid);
    await NodeFSP.writeFile(
      NodePath.join(directory, "recovery-proof.json"),
      JSON.stringify(
        {
          recovered,
          portRebound: port,
          preserved: [live, foreign],
          priorBootUsedLivePid: owner.pid,
        },
        null,
        2,
      ),
    );
  } finally {
    if (listener.listening)
      await new Promise((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    const existing = new Set((await run("docker", ["ps", "-aq", "--no-trunc"])).split(/\s+/));
    for (const id of containers) if (existing.has(id)) await run("docker", ["rm", "-f", id]);
    if (
      network &&
      (await run("docker", ["network", "ls", "-q", "--no-trunc"])).split(/\s+/).includes(network)
    )
      await run("docker", ["network", "rm", network]);
  }
}
