import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeFS from "node:fs";
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = NodeFS;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join, dirname } = NodePath;
import * as NodeURL from "node:url";
const { fileURLToPath } = NodeURL;
import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
const base = dirname(fileURLToPath(import.meta.url));
function run(args, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "t3ctl-test-"));
  const log = join(dir, "calls");
  try {
    mkdirSync(join(dir, "t3ctl"));
    writeFileSync(
      join(dir, "t3ctl/mcp-fixture.json"),
      JSON.stringify({
        resource: "http://fixture/mcp",
        accessToken: "test",
        expiresAt: "2099-01-01",
      }),
    );
    const cli = join(dir, "t3");
    writeFileSync(cli, "#!/bin/sh\necho test-token\n", { mode: 0o700 });
    if (extra.T3CTL_TEST_RELEASE_FALLBACK || extra.T3CTL_TEST_SSH_INSTALL) {
      const top = join(dir, "public", "t3-0.0.9-N");
      mkdirSync(top, { recursive: true });
      writeFileSync(join(top, "t3"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        join(dir, "runtime.tar.gz"),
        "-C",
        join(dir, "public"),
        "t3-0.0.9-N",
      ]);
      writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    }
    writeFileSync(
      join(dir, "ssh"),
      `#!/usr/bin/env node
const fs=require("node:fs"),args=process.argv.slice(2);
fs.appendFileSync(process.env.T3CTL_TEST_LOG,JSON.stringify({name:"ssh",args})+"\\n");
if(process.env.T3CTL_TEST_SSH_INSTALL) {
  if(args.at(-1).startsWith("tar ")) process.stdout.write(fs.readFileSync(process.env.T3CTL_TEST_PUBLIC_ARCHIVE));
  else console.log(JSON.stringify({root:"/remote/runtime/versions",versions:["0.0.9-N"]}));
} else console.log(JSON.stringify({credential:"pairing-test",state:"watching",environmentId:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",label:"lab"}));
`,
      { mode: 0o700 },
    );
    const r = spawnSync(
      process.execPath,
      ["--import", join(base, "mesh-test-transport.mjs"), join(base, "t3ctl.mjs"), ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          XDG_CONFIG_HOME: dir,
          XDG_STATE_HOME: dir,
          T3CODE_HOME: join(dir, "home"),
          T3CTL_TEST_PUBLIC_ARCHIVE: join(dir, "runtime.tar.gz"),
          T3CTL_ORIGIN: "http://fixture",
          T3CTL_T3_BIN: cli,
          T3CTL_TEST_LOG: log,
          PATH: dir + ":" + process.env.PATH,
          ...extra,
        },
      },
    );
    assert.equal(r.status, Number(extra.expectedCode || 0), r.stderr);
    return {
      out: r.stdout,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
      installed: NodeFS.existsSync(join(dir, "home/runtime/versions/0.0.9-N/t3")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const peer = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
test("machine inventory, mesh status, replicas and layout reach transports", () => {
  for (const args of [
    ["machines", "--json"],
    ["mesh", "status", "--json"],
    ["replicas", "--json"],
    ["layout", "get", "--json"],
  ])
    assert.ok(run(args).calls.some((c) => c.name === "meshLayout.get"));
});
test("place, unplace, retry resolve Russian machine and send server contracts", () => {
  const primary = run(["place", "Demo", "--on", "лаборатория", "--primary", "--path", "/checkout"]);
  assert.equal(primary.calls.find((c) => c.name === "t3_project_place").args.role, "primary");
  const placed = run([
    "place",
    "Demo",
    "--on",
    "на лаборатории",
    "--source",
    "офис",
    "--wait",
    "2m",
    "--path",
    "~/replica",
  ]);
  assert.deepEqual(placed.calls.find((c) => c.name === "t3_project_place").args, {
    project: "p",
    machine: peer,
    source: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    path: "~/replica",
    wait: 120,
  });
  assert.equal(
    run(["unplace", "Demo", "--on", "лаборатория", "--yes"]).calls.find(
      (c) => c.name === "t3_project_place",
    ).args.action,
    "remove",
  );
  assert.deepEqual(
    run(["replica", "retry", "Demo", "--on", "LB"]).calls.find((c) => c.name === "replicas.retry")
      .args,
    { logicalKey: "repo", environmentId: peer },
  );
});
test("remote new places before launch and reuses registered representation", () => {
  const args = ["new", "--project", "Demo", "--on", "лаборатория", "--json", "task"];
  for (const existing of ["", "1"]) {
    const { calls } = run(args, { T3CTL_TEST_EXISTING: existing });
    const launch = calls.find((c) => c.name === "t3_thread_launch");
    assert.equal(launch.args.environmentId, peer);
    assert.equal(launch.args.projectId, "remote-p");
    assert.equal(
      calls.some((c) => c.name === "t3_project_place"),
      !existing,
    );
    if (!existing)
      assert.ok(calls.findIndex((c) => c.name === "t3_project_place") < calls.indexOf(launch));
  }
});
test("find all and legacy fallback retain machine tags; thread and status fan out", () => {
  for (const fallback of ["", "1"]) {
    const r = run(["find", "mount", "--json"], { T3CTL_TEST_FALLBACK: fallback });
    assert.equal(JSON.parse(r.out).matches.at(-1).machineTag, "LB");
  }
  for (const cmd of ["threads", "status"]) {
    const r = run([cmd, "--all", "--json"]);
    assert.ok(r.calls.some((c) => c.name === "t3_thread_list" && c.args.environmentId === peer));
  }
});
test("open thread/file and cat preserve destination and remote home path", () => {
  const r = run(["open", "mount", "--on", "лаборатория", "--json"]);
  assert.equal(JSON.parse(r.out).environmentId, peer);
  for (const args of [
    ["open-file", "~/a b.md", "--on", "лаборатория", "--json"],
    ["cat", "~/a b.md", "--on", "лаборатория"],
  ]) {
    const r = run(args);
    assert.ok(
      r.calls.some((c) => c.args.environmentId === peer || c.args.target?.environmentId === peer),
    );
  }
});
test("link mints a code over ssh and unlink uses the resolved environment", () => {
  const r = run(["mesh", "link", "лаборатория", "--url", "http://peer"]);
  const input = r.calls.find((c) => c.name === "peerLinks.link").args;
  assert.equal(input.pairingCode, "pairing-test");
  assert.equal(input.access, "full-access");
  assert.equal(input.expectedEnvironmentId, peer);
  assert.deepEqual(
    run(["mesh", "unlink", "лаборатория", "--yes"]).calls.find((c) => c.name === "peerLinks.unlink")
      .args,
    { environmentId: peer },
  );
});
test("layout dry run never writes; apply sends the document through server adoption", () => {
  for (const flag of ["--dry-run", "--apply"]) {
    const r = run(["layout", "merge", "--from", "офис", flag]);
    assert.equal(
      r.calls.some((c) => c.name === "meshLayout.apply"),
      flag === "--apply",
    );
  }
});

test("remote new wait and history remain on destination", () => {
  const r = run(["new", "--project", "Demo", "--on", "лаборатория", "--wait", "1s", "task"]);
  for (const name of ["t3_thread_wait", "t3_thread_read"])
    assert.equal(r.calls.find((c) => c.name === name).args.environmentId, peer);
});
test("existing requests command supports the consolidated pending-request API", () => {
  const r = run(["requests", "mount"]);
  assert.ok(r.calls.some((c) => c.name === "t3_pending_request" && c.args.action === "list"));
});

test("destructive mesh commands require yes before sending mutations", () => {
  for (const args of [
    ["mesh", "unlink", "лаборатория"],
    ["unplace", "Demo", "--on", "лаборатория"],
  ]) {
    const r = run(args, { expectedCode: "1" });
    assert.ok(!r.calls.some((c) => ["peerLinks.unlink", "t3_project_place"].includes(c.name)));
  }
});

test("retry follows the remote replica driver over ssh", () => {
  const r = run(["replica", "retry", "Demo", "--on", "лаборатория"], {
    T3CTL_TEST_REMOTE_DRIVER: "1",
  });
  assert.ok(
    r.calls.some((c) => c.name === "ssh" && c.args.some((a) => a.includes("replicas.retry"))),
  );
  assert.ok(!r.calls.some((c) => c.name === "replicas.retry"));
});

test("link discovers an unknown machine over ssh before pairing", () => {
  const r = run(["mesh", "link", "new-host", "--ssh", "lab", "--url", "http://peer"]);
  assert.ok(r.calls.some((c) => c.name === "ssh" && c.args.some((a) => a.includes("env"))));
  assert.equal(r.calls.find((c) => c.name === "peerLinks.link").args.expectedEnvironmentId, peer);
});

test("session commands resolve ids in the mesh and pending questions use current MCP actions", () => {
  for (const [command, tool, rest] of [
    ["show", "t3_thread_read", []],
    ["send", "t3_thread_send", ["hello"]],
    ["wait", "t3_thread_wait", []],
    ["stop", "t3_thread_interrupt", []],
  ]) {
    const r = run([command, "mcp:remote-thread", ...rest]);
    assert.ok(r.calls.some((c) => c.name === tool));
    assert.ok(
      r.calls.some(
        (c) =>
          c.name === "t3_thread_read" &&
          c.args.threadId === "mcp:remote-thread" &&
          c.args.environmentId === undefined,
      ),
    );
  }
  const requests = run(["requests", "mcp:remote-thread"], { T3CTL_TEST_QUESTION: "1" });
  assert.ok(
    requests.calls.some((c) => c.name === "t3_pending_request" && c.args.action === "list"),
  );
  assert.ok(
    requests.calls.some((c) => c.name === "t3_pending_request" && c.args.action === "read"),
  );
  const answered = run(["answer", "mcp:remote-thread", "yes"], { T3CTL_TEST_QUESTION: "1" });
  assert.ok(
    answered.calls.some(
      (c) =>
        c.name === "t3_pending_request" &&
        c.args.action === "respond" &&
        c.args.answers.q === "yes",
    ),
  );
  const self = run(["self"], {
    T3_MCP_URL: "http://fixture/mcp",
    T3_MCP_BEARER_TOKEN: "scoped-test",
  });
  assert.ok(self.calls.some((c) => c.name === "t3_thread_self"));
  const named = run(["show", "Mount: a long thread title that needs mesh name resolution"], {
    T3CTL_TEST_LONG_TITLE: "1",
  });
  assert.ok(named.calls.some((c) => c.name === "t3_thread_list" && c.args.environmentId === "all"));
});

test("thread ids in printed output retain the full MCP prefix and body", () => {
  const id = "mcp:full-thread-example-0123456789";
  const sent = run(["send", id, "hello"], { T3CTL_TEST_FULL_ID: "1" });
  assert.ok(sent.out.includes(id), sent.out);
});

test("mesh and replica text use the project title, and adoption reaches the management service", () => {
  for (const command of [["mesh", "status"], ["replicas"]]) {
    const result = run(command);
    assert.match(result.out, /Demo/);
    assert.doesNotMatch(result.out, /\srepo\s/);
  }
  const result = run(["replica", "adopt", "N-manual", "--project", "Demo"]);
  assert.deepEqual(result.calls.find((call) => call.name === "replicas.adopt").args, {
    project: "p",
    session: "N-manual",
  });
  assert.match(result.out, /original session stays paused/);
  const remote = run(["replica", "adopt", "N-remote", "--project", "Remote project"]);
  assert.deepEqual(remote.calls.find((call) => call.name === "replicas.adopt").args, {
    project: "lp-remote",
    session: "N-remote",
  });
  assert.match(remote.out, /Remote project/);
  for (const command of [
    ["place", "Remote project", "--on", "LB", "--json"],
    ["unplace", "Remote project", "--on", "LB", "--yes", "--json"],
  ]) {
    const result = run(command);
    assert.equal(
      result.calls.find((call) => call.name === "t3_project_machines").args.project,
      "Remote project",
    );
    assert.equal(
      result.calls.find((call) => call.name === "t3_project_place").args.project,
      "lp-remote",
    );
  }
  const placed = run([
    "place",
    "Demo",
    "--on",
    "LB",
    "--path",
    "/explicit/path",
    "--ignore",
    "*.cache",
    "--ignore",
    "scratch",
    "--transport",
    "manual",
  ]);
  const input = placed.calls.find((call) => call.name === "t3_project_place").args;
  assert.equal(input.path, "/explicit/path");
  assert.equal(input.transport, "manual");
  assert.deepEqual(input.ignores, ["*.cache", "scratch"]);
});

test("server install falls back without authenticated gh to public HTTPS or a linked SSH cache", () => {
  const publicResult = run(["server", "install", "latest"], { T3CTL_TEST_RELEASE_FALLBACK: "1" });
  assert.equal(publicResult.installed, true);
  assert.match(publicResult.out, /installed 0\.0\.9-N/);
  const sshResult = run(["server", "install", "latest", "--from", "LB"], {
    T3CTL_TEST_SSH_INSTALL: "1",
  });
  assert.equal(sshResult.installed, true);
  assert.match(sshResult.out, /from gor/);
});

test("aliases read and edit the layout machine without replacing other fields", () => {
  const listing = run(["machines", "alias", "lab", "list", "--json"]);
  assert.deepEqual(JSON.parse(listing.out).aliases, ["лаборатория", "лаборатории"]);
  assert.ok(!listing.calls.some((call) => call.name === "meshLayout.apply"));
  for (const [operation, rest, expected] of [
    ["add", [" Studio ", "STUDIO", "研究室"], ["лаборатория", "лаборатории", "STUDIO", "研究室"]],
    ["remove", ["ЛАБОРАТОРИЯ"], ["лаборатории"]],
    ["clear", [], undefined],
  ]) {
    const result = run(["machines", "alias", "лаборатория", operation, ...rest, "--json"]);
    const entries = result.calls.find((call) => call.name === "meshLayout.apply").args.entries;
    assert.deepEqual(Object.keys(entries), [`machine/${peer}`]);
    const entry = entries[`machine/${peer}`];
    assert.deepEqual(entry.v, {
      label: "lab",
      tag: "LB",
      color: "#123456",
      ...(expected ? { aliases: expected } : {}),
    });
    assert.ok(entry.h > "0000000000000.00000.fixture");
  }
});

test("new uses destination defaults and resolves explicit models against destination capabilities", () => {
  const implicit = run(["new", "--project", "Demo", "--on", "lab", "task"]);
  const input = implicit.calls.find((call) => call.name === "t3_thread_launch").args;
  assert.equal(input.environmentId, peer);
  assert.equal(input.modelSelection, undefined);
  assert.equal(input.runtimeMode, undefined);
  assert.ok(!implicit.calls.some((call) => call.name === "orchestrator_capabilities"));
  const explicit = run(["new", "--project", "Demo", "--on", "lab", "--agent", "custom", "task"]);
  assert.deepEqual(explicit.calls.find((call) => call.name === "orchestrator_capabilities").args, {
    environmentId: peer,
  });
  const selection = explicit.calls.find((call) => call.name === "t3_thread_launch").args
    .modelSelection;
  assert.equal(selection.instanceId, "custom");
  assert.equal(selection.model, "model-from-destination");
});

test("full selftest requires an explicit provider and models before any server operation", () => {
  const result = spawnSync("bash", [join(base, "selftest.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      T3CTL_FULL_SELFTEST: "1",
      T3CTL_SELFTEST_AGENT: "",
      T3CTL_SELFTEST_MODEL: "",
      T3CTL_SELFTEST_ALT_MODEL: "",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /set T3CTL_SELFTEST_AGENT from the test server's model catalog/);
  assert.equal(result.stdout, "");
});
