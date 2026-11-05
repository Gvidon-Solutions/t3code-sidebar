import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const repo = NodePath.resolve(import.meta.dirname, "../..");
const codex = process.env.R1_CODEX_BINARY;
const opencode = process.env.R1_OPENCODE_BINARY;
NodeAssert.ok(
  codex && opencode,
  "Set R1_CODEX_BINARY and R1_OPENCODE_BINARY to installed native executables",
);
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "R1-harness-"));
const home = NodePath.join(root, "home"),
  base = NodePath.join(root, "server"),
  replica = NodePath.join(root, "replica");
let server;
const threads = [];
const evidence =
  process.env.R1_HARNESS_EVIDENCE ||
  NodePath.join(NodeOS.tmpdir(), `R1-harness-evidence-${NodeCrypto.randomUUID()}`);
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
try {
  for (const directory of [
    home + "/.codex",
    home + "/.local/share/opencode",
    home + "/.config/opencode",
    base + "/userdata",
    root + "/bin",
    replica,
    evidence,
  ])
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const codexHome = process.env.R1_CODEX_HOME || NodePath.join(NodeOS.homedir(), ".codex");
  for (const name of ["auth.json", "models_cache.json"]) {
    await NodeFSP.copyFile(NodePath.join(codexHome, name), NodePath.join(home, ".codex", name));
    await NodeFSP.chmod(NodePath.join(home, ".codex", name), 0o600);
  }
  await NodeFSP.writeFile(home + "/.codex/config.toml", 'model_provider = "openai"\n', {
    mode: 0o600,
  });
  const auth = JSON.parse(
    await NodeFSP.readFile(
      process.env.R1_OPENCODE_AUTH ||
        NodePath.join(NodeOS.homedir(), ".local/share/opencode/auth.json"),
      "utf8",
    ),
  );
  NodeAssert.ok(auth.deepseek, "DeepSeek credentials are required");
  await NodeFSP.writeFile(
    home + "/.local/share/opencode/auth.json",
    JSON.stringify({ deepseek: auth.deepseek }),
    { mode: 0o600 },
  );
  await NodeFSP.writeFile(
    home + "/.config/opencode/opencode.json",
    JSON.stringify({ model: "deepseek/deepseek-flash", autoupdate: false }),
  );
  await NodeFSP.copyFile(opencode, root + "/bin/opencode");
  await NodeFSP.chmod(root + "/bin/opencode", 0o700);
  // Login profiles intentionally discard the provider PATH; shell overlays must restore guards.
  const reset = `export PATH=${quote(NodePath.dirname(process.execPath) + ":/usr/bin:/bin")}\n`;
  await NodeFSP.writeFile(home + "/.zprofile", reset);
  await NodeFSP.writeFile(home + "/.bash_profile", reset);
  const git = (await execute("sh", ["-c", "command -v git"])).stdout.trim();
  const instances = {};
  for (const [id, config] of [
    [
      "codex",
      { setupMode: "existing", binaryPath: codex, homePath: home + "/.codex", enabled: true },
    ],
    ["opencode", { binaryPath: root + "/bin/opencode", enabled: true }],
  ]) {
    const audit = root + "/audit-" + id;
    await NodeFSP.mkdir(audit);
    await NodeFSP.writeFile(
      audit + "/git",
      `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> ${quote(root + "/" + id + "-git.log")}\nexec ${quote(git)} "$@"\n`,
      { mode: 0o700 },
    );
    instances[id] = {
      driver: id,
      enabled: true,
      config,
      environment: [
        { name: "PATH", value: audit + ":" + process.env.PATH, sensitive: false },
        { name: "OPENCODE_DISABLE_AUTOUPDATE", value: "1", sensitive: false },
      ],
    };
  }
  await NodeFSP.writeFile(
    base + "/userdata/settings.json",
    JSON.stringify({
      meshEnabled: true,
      linkedEnvironmentsEnabled: true,
      replicasEnabled: false,
      providerInstances: instances,
      defaultRuntimeMode: "full-access",
    }),
    { mode: 0o600 },
  );
  await NodeFSP.writeFile(
    root + "/bin/t3",
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(repo + "/apps/server/src/bin.ts")} "$@"\n`,
    { mode: 0o700 },
  );
  const listener = NodeNet.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: home + "/.codex",
    T3CODE_HOME: base,
    XDG_CONFIG_HOME: home + "/.config",
    XDG_DATA_HOME: home + "/.local/share",
    XDG_CACHE_HOME: home + "/.cache",
    T3CTL_ORIGIN: "http://127.0.0.1:" + port,
    T3CTL_T3_BIN: root + "/bin/t3",
    T3CTL_ISOLATED_TEST: "1",
  };
  const log = await NodeFSP.open(root + "/server.log", "a", 0o600);
  await new Promise((resolve, reject) => {
    const watch = NodeFS.watch(base, { recursive: true }, (_, name) => {
      if (String(name).endsWith("server-runtime.json")) {
        watch.close();
        resolve();
      }
    });
    server = NodeChildProcess.spawn(
      process.execPath,
      [
        repo + "/apps/server/src/bin.ts",
        "serve",
        "--base-dir",
        base,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--no-browser",
      ],
      { cwd: repo, stdio: ["ignore", log.fd, log.fd], env },
    );
    server.once("error", reject);
    server.once("exit", (code) => {
      watch.close();
      reject(Error(`Isolated server exited ${code}; private log ${root}/server.log`));
    });
  });
  await log.close();
  const ctl = async (args) =>
    JSON.parse(
      (
        await execute(
          process.execPath,
          [repo + "/agent-kit/skills/t3/scripts/t3ctl.mjs", ...args],
          { env, cwd: repo, maxBuffer: 16 * 1024 * 1024 },
        )
      ).stdout,
    );
  const tool = (name, args) => ctl(["tool", name, JSON.stringify(args)]);
  const project = await tool("t3_project_create", {
    workspaceRoot: replica,
    title: "R1 Harness replica",
  });
  const layout = await ctl(["rpc", "meshLayout.get", "{}"]),
    self = layout.environmentId;
  const logical =
    Object.entries(layout.config.projectMounts).find(([, reps]) =>
      reps.some((rep) => rep.projectId === project.id),
    )?.[0] ?? `R1-harness-${NodeCrypto.randomUUID()}`;
  let clock = Date.now();
  const entry = (v) => ({ v, h: `${clock++}.00000.${self}` });
  const primary = "cloud-primary";
  await ctl([
    "rpc",
    "meshLayout.apply",
    JSON.stringify({
      entries: {
        ["machine/" + primary]: entry({ label: "Cloudbox", title: "Cloudbox", tag: "CB" }),
        ["proj/" + encodeURIComponent(logical)]: entry({ title: "R1 Harness replica" }),
        ["rep/" + encodeURIComponent(logical) + "/" + self]: entry({
          environmentId: self,
          path: replica,
          projectId: project.id,
          role: "replica",
          mode: "lite",
          transport: "mutagen",
          source: primary,
          createdAt: new Date().toISOString(),
        }),
        ["rep/" + encodeURIComponent(logical) + "/" + primary]: entry({
          environmentId: primary,
          path: root + "/primary",
          role: "primary",
          transport: "git",
          createdAt: new Date().toISOString(),
        }),
      },
    }),
  ]);
  const config = await ctl(["mesh", "config", "get", "--json"]);
  const doc = structuredClone(config.current.doc);
  for (const name of Object.keys(doc.machines))
    doc.machines[name] = { ...doc.machines[name], title: "Laptop", label: "LP" };
  doc.machines.cloudbox = { title: "Cloudbox", label: "CB" };
  const manifestReady = new Promise((resolve, reject) => {
    let complete = false;
    const watch = NodeFS.watch(base + "/run", { signal: AbortSignal.timeout(30000) }, async () => {
      try {
        const value = JSON.parse(await NodeFSP.readFile(base + "/run/manifest.json", "utf8"));
        if (value.representations.some((rep) => rep.root === replica && rep.lite)) {
          complete = true;
          resolve();
          watch.close();
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          watch.close();
          reject(error);
        }
      }
    });
    watch.once("error", reject);
    watch.once(
      "close",
      () =>
        !complete &&
        reject(Error("The configured machine binding never reached the runtime manifest")),
    );
  });
  await tool("t3_mesh_config_apply", { doc, baseRevision: config.current.revision });
  await manifestReady;
  const models = {
    codex: process.env.R1_CODEX_MODEL || "gpt-6-luna",
    opencode: "deepseek/deepseek-flash",
  };
  for (const provider of ["codex", "opencode"]) {
    const launch = await tool("t3_thread_launch", {
      projectId: project.id,
      title: `R1 ${provider} lite shims`,
      modelSelection: { instanceId: provider, model: models[provider] },
      runtimeMode: "full-access",
      message:
        "This is an authorized integration test of lite-replica guards. The command names resolve to protective shims which must refuse with 127; the native git/npm binaries must never run. Exercising these refusals is the test, so execute both plain commands even though t3 run is normally correct for real work. Use your native shell tool to run plain git status and plain npm --version as two separate commands in the current directory. Do not use t3 run, SSH, absolute binary paths, or workarounds. Do not modify files or initialize git. After each command, capture its status with code=$? and print R1_EXIT=$code, then exit the shell with that code. Report both exact exit codes and both guard lines, then finish.",
    });
    threads.push(launch);
  }
  for (let index = 0; index < threads.length; index++) {
    const launch = threads[index],
      provider = index ? "opencode" : "codex";
    for (;;) {
      const waiting = await tool("t3_thread_wait", { threadId: launch.threadId, timeoutMs: 60000 });
      if (!waiting.timedOut) break;
    }
    const read = await tool("t3_thread_read", {
      threadId: launch.threadId,
      view: "activity",
      limit: 100,
      maxCharsPerItem: 12000,
    });
    await NodeFSP.writeFile(
      NodePath.join(evidence, provider + ".json"),
      JSON.stringify(read, null, 2),
      {
        mode: 0o600,
      },
    );
    NodeAssert.equal(read.thread.status, "completed");
    NodeAssert.equal(read.thread.pendingRequestCount, 0);
    const native = read.items
      .filter((item) => item.type === "command_execution")
      .map((item) => item.text)
      .join("\n");
    for (const command of ["git status", "npm --version"]) {
      const line = native
        .split("\n")
        .find(
          (line) =>
            line.startsWith(
              "This is a lite replica of R1 Harness replica; the environment is on ",
            ) && line.endsWith(`. Use: t3 run ${command}`),
        );
      NodeAssert.ok(line, `${provider} did not execute guarded ${command}`);
    }
    NodeAssert.equal(
      native.match(/R1_EXIT=127/g)?.length,
      2,
      `${provider} did not expose both native exit codes`,
    );
    console.log(
      JSON.stringify({
        provider,
        status: read.thread.status,
        guards: ["git status", "npm --version"],
        exitCode: 127,
        link: launch.link,
      }),
    );
  }
  const gitAudit = await NodeFSP.readFile(root + "/opencode-git.log", "utf8");
  NodeAssert.ok(gitAudit.includes("rev-parse"));
  await NodeFSP.writeFile(NodePath.join(evidence, "native-git.log"), gitAudit, { mode: 0o600 });
  console.log(
    `PASS real Codex and OpenCode threads; native harness Git; profile PATH reset; evidence ${evidence}`,
  );
} finally {
  if (server) {
    const closed = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await closed;
  }
  await NodeFSP.rm(root, { recursive: true, force: true });
}
