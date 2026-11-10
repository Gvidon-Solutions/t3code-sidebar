// @effect-diagnostics nodeBuiltinImport:off -- The dispatch test spawns the real CLI entrypoint and its fast paths.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

const bin = NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));
const watched = [
  "./binMain.ts",
  "./fastMain.ts",
  "./cli/managedChatGptToken.ts",
  "./cli/serviceLauncher.ts",
  "./mcp/AcpMcpStdioBridge.ts",
  "./provider/documentTextWorker.ts",
  "./run/RunCli.ts",
  "./run/RunGuardian.ts",
  "./run/RunShim.ts",
  "./run/RunWorkerEntry.ts",
];
const hooks = `
import { registerHooks } from "node:module";
const watched = new Set(${JSON.stringify(watched)});
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (watched.has(specifier)) console.error("FASTPATH:" + specifier);
    return nextResolve(specifier, context);
  },
});
`;

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const cli = (
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string } = {},
): Result => {
  const env = { ...process.env };
  for (const name of [
    "T3CODE_RUN_MANIFEST",
    "T3CODE_RUN_SHIMS",
    "T3CODE_RUN_SOCKET",
    "T3_ACP_MCP_ENDPOINT",
    "T3_ACP_MCP_AUTHORIZATION",
  ])
    delete env[name];
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      `data:text/javascript,${encodeURIComponent(hooks)}`,
      bin,
      ...args,
    ],
    {
      cwd: options.cwd,
      env: { ...env, ...options.env },
      input: "",
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};

const expectFastPath = (result: Result, module: string) => {
  expect(result.stderr).toContain("FASTPATH:./fastMain.ts");
  expect(result.stderr).toContain(`FASTPATH:${module}`);
  expect(result.stderr).not.toContain("FASTPATH:./binMain.ts");
};

it("dispatches every fork fast path before the full CLI and keeps its argv contract", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bin-dispatch-"));
  try {
    const manifest = NodePath.join(root, "manifest.json");
    const shims = NodePath.join(root, "shims");
    await NodeFSP.writeFile(manifest, '{"representations":[],"commands":[]}');
    const replica = NodePath.join(root, "replica");
    await NodeFSP.mkdir(replica);
    const liteManifest = NodePath.join(root, "lite-manifest.json");
    await NodeFSP.writeFile(
      liteManifest,
      JSON.stringify({
        representations: [{ root: replica, lite: true, title: "Studio", machine: "cloudbox" }],
        commands: ["git"],
      }),
    );

    const run = cli(["run", "--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("t3 run [--bg]");
    expectFastPath(run, "./run/RunCli.ts");

    const shim = cli(["__replica-command", "true"], {
      env: { T3CODE_RUN_MANIFEST: manifest, T3CODE_RUN_SHIMS: shims },
      cwd: root,
    });
    expect(shim.code).toBe(0);
    expectFastPath(shim, "./run/RunShim.ts");

    const liteShim = cli(["__replica-command", "git", "status"], {
      env: { T3CODE_RUN_MANIFEST: liteManifest, T3CODE_RUN_SHIMS: shims },
      cwd: replica,
    });
    expect(liteShim.code).toBe(127);
    expect(liteShim.stderr).toContain(
      "This is a lite replica of Studio; the environment is on cloudbox. Use: t3 run git status",
    );
    expectFastPath(liteShim, "./run/RunShim.ts");

    const notebook = NodePath.join(root, "note.ipynb");
    await NodeFSP.writeFile(
      notebook,
      JSON.stringify({ cells: [{ cell_type: "markdown", source: ["hello c2"] }] }),
    );
    const document = cli(["__document-text", notebook, ".ipynb"]);
    expect(document.code).toBe(0);
    expect(document.stdout).toContain("hello c2");
    expectFastPath(document, "./provider/documentTextWorker.ts");

    const managedToken = cli(["__managed-chatgpt-token"]);
    expect(managedToken.code).toBe(1);
    expect(managedToken.stderr).toContain("Could not access the managed ChatGPT connection.");
    expectFastPath(managedToken, "./cli/managedChatGptToken.ts");

    const bridge = cli(["acp-mcp-bridge"]);
    expect(bridge.code).toBe(2);
    expect(bridge.stderr).toContain(
      "acp-mcp-bridge requires T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION.",
    );
    expectFastPath(bridge, "./mcp/AcpMcpStdioBridge.ts");

    const call = cli(["acp-mcp-call"], {
      env: { T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:1/mcp", T3_ACP_MCP_AUTHORIZATION: "Bearer t" },
    });
    expect(call.code).toBe(2);
    expect(call.stderr).toContain("acp-mcp-call requires <tool> and <arguments-json>.");
    expectFastPath(call, "./mcp/AcpMcpStdioBridge.ts");

    const worker = cli(["__run-worker", Buffer.from("{}").toString("base64")]);
    expect(worker.code).not.toBe(0);
    expectFastPath(worker, "./run/RunWorkerEntry.ts");

    const guardian = cli(["__run-guardian", Buffer.from("{}").toString("base64")]);
    expect(guardian.code).toBe(255);
    expectFastPath(guardian, "./run/RunGuardian.ts");

    const launcher = cli(["__service-launcher"], { env: { T3CODE_HOME: "" } });
    expect(launcher.code).toBe(1);
    expect(launcher.stderr).toContain("[service-launcher] T3CODE_HOME is required");
    expect(launcher.stderr).toContain("FASTPATH:./cli/serviceLauncher.ts");
    expect(launcher.stderr).not.toContain("FASTPATH:./binMain.ts");
    expect(launcher.stderr).not.toContain("FASTPATH:./fastMain.ts");

    const fallback = cli(["--version"]);
    expect(fallback.code).toBe(0);
    expect(fallback.stdout).toMatch(/^t3 v/);
    expect(fallback.stderr).toContain("FASTPATH:./binMain.ts");
    expect(fallback.stderr).not.toContain("FASTPATH:./fastMain.ts");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
