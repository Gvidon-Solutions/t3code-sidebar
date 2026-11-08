import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

const directory = import.meta.dirname;
const setup = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesh-isolation-"));
  const bed = NodePath.join(root, "scripts/mesh-e2e");
  const home = NodePath.join(root, "home");
  const state = NodePath.join(root, "state");
  NodeFS.mkdirSync(bed, { recursive: true });
  NodeFS.mkdirSync(home, { recursive: true });
  for (const name of ["lib.sh", "deploy.sh", "compose.yaml"])
    NodeFS.copyFileSync(NodePath.join(directory, name), NodePath.join(bed, name));
  const env = { PATH: "/usr/bin:/bin", HOME: home, MESH_E2E_STATE_DIR: state };
  return { root, bed, home, state, env };
};
const configured = (fixture, extra = "") => {
  NodeFS.writeFileSync(
    NodePath.join(fixture.bed, "local.env"),
    NodeFS.readFileSync(NodePath.join(directory, "local.env.example"), "utf8") + "\n" + extra,
  );
};
const source = (fixture, env = {}) =>
  NodeChildProcess.spawnSync(
    "/bin/bash",
    [
      "-c",
      '. "$1"; printf "%s\\n" "$NODE_B_UNIT" "$NODE_B_PORT" "$NODE_B_BASE_DIR" "$REVERSE_KEY_NODE_A" "$SELF_KEY"',
      "fixture",
      NodePath.join(fixture.bed, "lib.sh"),
    ],
    { env: { ...fixture.env, ...env }, encoding: "utf8" },
  );

NodeTest.test("configuration is required and default deployment is isolated", () => {
  const fixture = setup();
  try {
    const missing = source(fixture);
    NodeAssert.notEqual(missing.status, 0);
    NodeAssert.match(missing.stderr, /NODE_B_SSH_CONFIG/);
    configured(fixture);
    const result = source(fixture);
    NodeAssert.equal(result.status, 0, result.stderr);
    const [unit, port, base, reverse, self] = result.stdout.trim().split("\n");
    NodeAssert.equal(unit, "t3-mesh-e2e-nodeB.service");
    NodeAssert.equal(port, "3797");
    NodeAssert.equal(base, "/srv/t3-mesh-e2e/nodeB/server");
    for (const key of [reverse, self]) NodeAssert.ok(key.startsWith(`${fixture.state}/ssh/`));
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

NodeTest.test("live units, ports and base directories require an explicit live opt-in", () => {
  const fixture = setup();
  try {
    for (const setting of [
      "NODE_B_UNIT=t3code-sidebar.service",
      "NODE_B_PORT=3774",
      'NODE_B_BASE_DIR="$HOME/.t3-sidebar-server"',
    ]) {
      configured(fixture, setting);
      NodeAssert.notEqual(source(fixture).status, 0, setting);
      NodeAssert.equal(source(fixture, { MESH_E2E_ALLOW_LIVE: "1" }).status, 0, setting);
    }
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

NodeTest.test(
  "deploy writes sandbox units and never switches an installed customer service",
  () => {
    const fixture = setup();
    try {
      const bin = NodePath.join(fixture.root, "bin");
      const log = NodePath.join(fixture.root, "commands.jsonl");
      NodeFS.mkdirSync(bin);
      const stub = `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({command:process.argv[1],args:process.argv.slice(2),input:fs.readFileSync(0).toString('base64')})+'\\n');\n`;
      for (const command of ["ssh", "scp", "docker", "systemctl", "node", "curl"])
        NodeFS.writeFileSync(NodePath.join(bin, command), stub, { mode: 0o755 });
      const remote = NodePath.join(fixture.root, "remote");
      const cloud = NodePath.join(fixture.root, "cloud");
      configured(
        fixture,
        `NODE_A_NODE_BIN_DIR='${bin}'\nNODE_B_STATE_DIR='${remote}'\nNODE_B_DEMO_DIR='${remote}/projects/demo'\nCLOUD_DIR='${cloud}'`,
      );
      NodeFS.mkdirSync(NodePath.join(fixture.state, "artifacts"), { recursive: true });
      const runtime = NodePath.join(fixture.root, "runtime");
      NodeFS.mkdirSync(runtime);
      NodeFS.writeFileSync(NodePath.join(runtime, "t3"), "fixture");
      NodeFS.writeFileSync(
        NodePath.join(fixture.state, "artifacts/build.env"),
        `BUILD_VERSION=fixture\nARCHIVE='${fixture.root}/runtime.tar.gz'\nRUNTIME_DIR='${runtime}'\nCOMMIT=fixture\nCOMMIT_SHORT=fixture\n`,
      );
      const result = NodeChildProcess.spawnSync(
        "/bin/bash",
        [NodePath.join(fixture.bed, "deploy.sh")],
        {
          env: { ...fixture.env, FIXTURE_LOG: log, MESH_E2E_REUSE_NETWORK: "1" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      NodeAssert.equal(result.status, 0, result.stderr);
      const commands = NodeFS.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
      const sent = commands
        .filter(({ command }) => command.endsWith("/ssh"))
        .map(({ args, input }) => args.join(" ") + "\n" + Buffer.from(input, "base64").toString())
        .join("\n");
      NodeAssert.doesNotMatch(
        sent,
        /t3code-sidebar\.service|\.t3-sidebar-server|--port 3774|authorized_keys/,
      );
      NodeAssert.match(sent, /t3-mesh-e2e-nodeB\.service/);
      NodeAssert.ok(sent.includes(`Environment=HOME=${remote}/server/home`));
      const unit = NodeFS.readFileSync(
        NodePath.join(fixture.home, ".config/systemd/user/t3-mesh-e2e-nodeA.service"),
        "utf8",
      );
      NodeAssert.ok(unit.includes(`Environment=HOME=${fixture.state}/nodeA/server/home`));
      NodeAssert.match(unit, /--host 127\.0\.0\.1 --port 3795/);
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "shell scenarios never mutate an administrator SSH home or pin a private Node install",
  () => {
    for (const file of NodeFS.readdirSync(directory).filter((name) => name.endsWith(".sh"))) {
      const script = NodeFS.readFileSync(NodePath.join(directory, file), "utf8");
      NodeAssert.doesNotMatch(
        script,
        /(?:\$HOME|~)\/\.ssh|\.nvm\/versions\/node|StrictHostKeyChecking=accept-new/,
        file,
      );
    }
  },
);

NodeTest.test("round helpers resolve only the configured disposable runtime and base", () => {
  const fixture = setup();
  try {
    NodeFS.copyFileSync(
      NodePath.join(directory, "round1.sh"),
      NodePath.join(fixture.bed, "round1.sh"),
    );
    const bin = NodePath.join(fixture.root, "bin");
    NodeFS.mkdirSync(bin);
    for (const name of ["ssh", "scp", "docker"])
      NodeFS.writeFileSync(NodePath.join(bin, name), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    configured(
      fixture,
      `NODE_A_NODE_BIN_DIR='${bin}'\nNODE_B_STATE_DIR='${fixture.root}/remote'\nNODE_B_DEMO_DIR='${fixture.root}/remote/demo'`,
    );
    NodeFS.mkdirSync(NodePath.join(fixture.state, "artifacts"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(fixture.state, "artifacts/build.env"),
      "BUILD_VERSION=test\nARCHIVE=/fixture/archive\nRUNTIME_DIR=/fixture/runtime\n",
    );
    const result = NodeChildProcess.spawnSync(
      "/bin/bash",
      [
        "-c",
        '. "$1"; printf "%s\\n" "$NODE_B_BIN" "$NODE_B_UNIT" "$NODE_B_BASE_DIR"',
        "fixture",
        NodePath.join(fixture.bed, "round1.sh"),
      ],
      {
        encoding: "utf8",
        env: {
          ...fixture.env,
          PATH: bin + ":/usr/bin:/bin",
          MESH_E2E_HELPERS_ONLY: "1",
          MESH_E2E_ROUND1_WORK: NodePath.join(fixture.root, "work"),
        },
      },
    );
    NodeAssert.equal(result.status, 0, result.stderr);
    NodeAssert.deepEqual(result.stdout.trim().split("\n"), [
      fixture.root + "/remote/runtime/test/t3",
      "t3-mesh-e2e-nodeB.service",
      fixture.root + "/remote/server",
    ]);
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});
