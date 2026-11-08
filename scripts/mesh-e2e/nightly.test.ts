// @effect-diagnostics nodeBuiltinImport:off - Exercises real isolated shell processes and result files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "vite-plus/test";
import { nightly } from "./nightly.mjs";
it("writes both outcomes and posts only a failed run with the stable inbox key", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "nightly-policy-"));
  try {
    const calls = NodePath.join(root, "inbox.json");
    const inboxCommand = [
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(1)))`,
    ];
    const pass = await nightly({
      directory: NodePath.join(root, "pass"),
      command: [process.execPath, "-e", "console.log('realistic fixture passed')"],
      inboxCommand,
    });
    expect(pass.state).toBe("PASS");
    await expect(NodeFSP.stat(calls)).rejects.toMatchObject({ code: "ENOENT" });
    const fail = await nightly({
      directory: NodePath.join(root, "fail"),
      command: [process.execPath, "-e", "process.exitCode=7"],
      inboxCommand,
    });
    expect(fail.state).toBe("FAIL");
    expect(JSON.parse(await NodeFSP.readFile(calls, "utf8"))).toEqual([
      "inbox",
      "post",
      "attention",
      "Mesh nightly failed",
      "--body",
      await NodeFSP.readFile(NodePath.join(root, "fail/summary.md"), "utf8"),
      "--key",
      "mesh-nightly",
    ]);
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(root, "fail/summary.json"), "utf8")).state,
    ).toBe("FAIL");
    const expired = await nightly({
      directory: NodePath.join(root, "deadline"),
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      inboxCommand,
      timeoutMs: 1,
    });
    expect(expired.state).toBe("FAIL");
    expect(expired.error).toContain("execution deadline");
    expect(JSON.parse(await NodeFSP.readFile(calls, "utf8")).slice(-2)).toEqual([
      "--key",
      "mesh-nightly",
    ]);
    const forwarded = NodePath.join(root, "forwarded.json");
    await nightly({
      directory: NodePath.join(root, "forwarded"),
      command: [process.execPath, "-e", "process.exitCode=3"],
      inboxCommand: [
        process.execPath,
        "-e",
        `let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>body+=s);process.stdin.on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(forwarded)},JSON.stringify({body,args:process.argv.slice(1)})))`,
      ],
      inboxBodyViaStdin: true,
    });
    expect(JSON.parse(await NodeFSP.readFile(forwarded, "utf8"))).toEqual({
      body: await NodeFSP.readFile(NodePath.join(root, "forwarded/summary.md"), "utf8"),
      args: [],
    });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
