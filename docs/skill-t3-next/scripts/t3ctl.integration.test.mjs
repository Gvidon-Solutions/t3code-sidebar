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
    writeFileSync(
      join(dir, "ssh"),
      '#!/usr/bin/env node\nconst fs=require("node:fs");fs.appendFileSync(process.env.T3CTL_TEST_LOG,JSON.stringify({name:"ssh",args:process.argv.slice(2)})+"\\n");console.log(JSON.stringify({credential:"pairing-test",state:"watching",environmentId:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",label:"gor"}));\n',
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
          T3CTL_ORIGIN: "http://fixture",
          T3CTL_T3_BIN: cli,
          T3CTL_TEST_LOG: log,
          PATH: dir + ":" + process.env.PATH,
          ...extra,
        },
      },
    );
    assert.equal(r.status, Number(extra.expectedCode || 0), r.stderr);
    return { out: r.stdout, calls: readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) };
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
  const placed = run([
    "place",
    "Demo",
    "--on",
    "на горе",
    "--source",
    "гвидон",
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
    run(["unplace", "Demo", "--on", "гор", "--yes"]).calls.find(
      (c) => c.name === "t3_project_place",
    ).args.action,
    "remove",
  );
  assert.deepEqual(
    run(["replica", "retry", "Demo", "--on", "GO"]).calls.find((c) => c.name === "replicas.retry")
      .args,
    { logicalKey: "repo", environmentId: peer },
  );
});
test("remote new places before launch and reuses registered representation", () => {
  const args = ["new", "--project", "Demo", "--on", "гор", "--json", "task"];
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
    assert.equal(JSON.parse(r.out).matches.at(-1).machineTag, "GO");
  }
  for (const cmd of ["threads", "status"]) {
    const r = run([cmd, "--all", "--json"]);
    assert.ok(r.calls.some((c) => c.name === "t3_thread_list" && c.args.environmentId === peer));
  }
});
test("open thread/file and cat preserve destination and remote home path", () => {
  const r = run(["open", "mount", "--on", "гор", "--json"]);
  assert.equal(JSON.parse(r.out).environmentId, peer);
  for (const args of [
    ["open-file", "~/a b.md", "--on", "гор", "--json"],
    ["cat", "~/a b.md", "--on", "гор"],
  ]) {
    const r = run(args);
    assert.ok(
      r.calls.some((c) => c.args.environmentId === peer || c.args.target?.environmentId === peer),
    );
  }
});
test("link mints a code over ssh and unlink uses the resolved environment", () => {
  const r = run(["mesh", "link", "гор", "--url", "http://peer"]);
  const input = r.calls.find((c) => c.name === "peerLinks.link").args;
  assert.equal(input.pairingCode, "pairing-test");
  assert.equal(input.access, "full-access");
  assert.equal(input.expectedEnvironmentId, peer);
  assert.deepEqual(
    run(["mesh", "unlink", "гор", "--yes"]).calls.find((c) => c.name === "peerLinks.unlink").args,
    { environmentId: peer },
  );
});
test("layout dry run never writes; apply sends the document through server adoption", () => {
  for (const flag of ["--dry-run", "--apply"]) {
    const r = run(["layout", "merge", "--from", "гвидон", flag]);
    assert.equal(
      r.calls.some((c) => c.name === "meshLayout.apply"),
      flag === "--apply",
    );
  }
});

test("remote new wait and history remain on destination", () => {
  const r = run(["new", "--project", "Demo", "--on", "гор", "--wait", "1s", "task"]);
  for (const name of ["t3_thread_wait", "t3_thread_read"])
    assert.equal(r.calls.find((c) => c.name === name).args.environmentId, peer);
});
test("existing requests command supports the consolidated pending-request API", () => {
  const r = run(["requests", "mount"]);
  assert.ok(r.calls.some((c) => c.name === "t3_pending_request" && c.args.action === "list"));
});

test("destructive mesh commands require yes before sending mutations", () => {
  for (const args of [
    ["mesh", "unlink", "гор"],
    ["unplace", "Demo", "--on", "гор"],
  ]) {
    const r = run(args, { expectedCode: "1" });
    assert.ok(!r.calls.some((c) => ["peerLinks.unlink", "t3_project_place"].includes(c.name)));
  }
});

test("retry follows the remote replica driver over ssh", () => {
  const r = run(["replica", "retry", "Demo", "--on", "гор"], { T3CTL_TEST_REMOTE_DRIVER: "1" });
  assert.ok(
    r.calls.some((c) => c.name === "ssh" && c.args.some((a) => a.includes("replicas.retry"))),
  );
  assert.ok(!r.calls.some((c) => c.name === "replicas.retry"));
});

test("link discovers an unknown machine over ssh before pairing", () => {
  const r = run(["mesh", "link", "new-host", "--ssh", "gor", "--url", "http://peer"]);
  assert.ok(r.calls.some((c) => c.name === "ssh" && c.args.some((a) => a.includes("env"))));
  assert.equal(r.calls.find((c) => c.name === "peerLinks.link").args.expectedEnvironmentId, peer);
});
