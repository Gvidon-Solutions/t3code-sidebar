// Offline checks for the mesh argument parsing, machine resolver and legacy layout encoding.
// Run with: node --test scripts/t3ctl.unit.test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  buildMeshLinkInput,
  buildPlaceInput,
  buildUiOpenTarget,
  defaultMachineTag,
  encodeLegacyEntries,
  fileDeepLink,
  importLegacyEntries,
  normalizeMachineName,
  parseArgs,
  resolveMachineRef,
  threadDeepLink,
  threadWebUrl,
  waitSeconds,
} from "./t3ctl.mjs";

const MACHINES = [
  {
    environmentId: "11111111-1111-4111-8111-111111111111",
    label: "atlas",
    tag: "AT",
    sshAlias: "atlas",
    aliases: ["офис"],
  },
  {
    environmentId: "22222222-2222-4222-8222-222222222222",
    label: "lab",
    tag: "LB",
    sshAlias: "lab",
    aliases: ["лаборатория", "лаборатории", "研究室"],
  },
  {
    environmentId: "33333333-3333-4333-8333-333333333333",
    label: "Boreal",
    tag: "BO",
    sshAlias: "root@boreal",
    aliases: ["студия"],
  },
];

NodeTest.test("parseArgs keeps values, repeatable --from and optional --wait duration", () => {
  const a = parseArgs(["--on", "лаборатория", "--wait", "90", "--yes", "status"]);
  NodeAssert.deepEqual(a.pos, ["status"]);
  NodeAssert.equal(a.opt.on, "лаборатория");
  NodeAssert.equal(a.opt.wait, "90");
  NodeAssert.equal(a.opt.yes, true);

  const b = parseArgs(["--all", "find", "words"]);
  NodeAssert.equal(b.opt.all, true);
  NodeAssert.deepEqual(b.pos, ["find", "words"]);

  const c = parseArgs(["--from", "a", "--from", "b,c"]);
  NodeAssert.deepEqual(c.opt.from, ["a", "b,c"]);

  const d = parseArgs(["new", "--wait", "Reply with exactly: ALPHA", "--project", "P"]);
  NodeAssert.equal(d.opt.wait, true);
  NodeAssert.deepEqual(d.pos, ["new", "Reply with exactly: ALPHA"]);
  NodeAssert.equal(d.opt.project, "P");

  NodeAssert.equal(parseArgs(["--dry-run"]).opt.dryRun, true);
});

NodeTest.test(
  "machine names cover ids, labels, tags, ssh aliases and user-defined multilingual aliases",
  () => {
    NodeAssert.equal(resolveMachineRef("офис", MACHINES).label, "atlas");
    NodeAssert.equal(resolveMachineRef("на лаборатории", MACHINES).label, "lab");
    NodeAssert.equal(resolveMachineRef("лаборатория", MACHINES).label, "lab");
    NodeAssert.equal(resolveMachineRef("студия", MACHINES).label, "Boreal");
    NodeAssert.equal(resolveMachineRef("BO", MACHINES).label, "Boreal");
    NodeAssert.equal(resolveMachineRef("root@boreal", MACHINES).label, "Boreal");
    NodeAssert.equal(resolveMachineRef("2222", MACHINES).label, "lab");
    NodeAssert.equal(resolveMachineRef("atlas", MACHINES).label, "atlas");
    NodeAssert.equal(normalizeMachineName("На лаборатории"), "налаборатории");
    NodeAssert.equal(resolveMachineRef("研究室", MACHINES).label, "lab");
    NodeAssert.throws(() => resolveMachineRef("нет такой", MACHINES), /no machine/);
    NodeAssert.throws(
      () =>
        resolveMachineRef(
          "shared",
          MACHINES.map((machine) => ({ ...machine, aliases: ["shared"] })),
        ),
      /matches 3 machines/,
    );
  },
);

NodeTest.test("an exact label wins over a longer different machine", () => {
  const machines = [
    ...MACHINES,
    { environmentId: "11111111-1111-1111-1111-111111111111", label: "lab-old", tag: "G2" },
  ];
  NodeAssert.equal(resolveMachineRef("lab", machines).label, "lab");
  NodeAssert.equal(resolveMachineRef("lab-old", machines).label, "lab-old");
});

NodeTest.test("fractional encoding matches @t3tools/shared/meshLayout for a full config", () => {
  const config = {
    workspaces: [
      { id: "w1", name: "Main", icon: "M", color: "#e0795b" },
      { id: "w2", name: "Quiet" },
    ],
    assignments: { "github.com/a/b": "w1" },
    placements: { "github.com/a/b": ["w1", "w2"] },
    rules: [{ match: "**/repos/**", workspace: "w1" }],
    defaultWorkspace: "w1",
    projectOrder: ["github.com/a/b"],
    workspaceProjectOrder: { w1: ["github.com/a/b"], w2: [] },
    workspaceFold: { w1: { "github.com/a/b": "active" } },
    quietAfterDays: 5,
    alwaysShow: ["github.com/a/b"],
    alwaysQuiet: [],
    machines: {
      "env-1": { label: "Boreal", tag: "BO", reach: { "env-2": { ssh: "root@boreal" } } },
    },
    projectAliases: { "env-2:/root/x": "github.com/a/b" },
    projectMounts: {
      "github.com/a/b": [
        {
          environmentId: "env-1",
          path: "/root/x",
          projectId: "p1",
          transport: "git",
          role: "primary",
        },
      ],
    },
    projectMountStatus: {
      "github.com/a/b": { "env-1": { state: "watching", updatedAt: "2026-01-01T00:00:00.000Z" } },
    },
  };
  NodeAssert.deepEqual(encodeLegacyEntries(config), {
    "ws/w1": { name: "Main", icon: "M", color: "#e0795b", sort: "F" },
    "ws/w2": { name: "Quiet", sort: "V" },
    "rule/**%2Frepos%2F**%00w1%000": { match: "**/repos/**", workspace: "w1", sort: "V" },
    "ws.default": "w1",
    "ws.quietAfterDays": 5,
    "order/github.com%2Fa%2Fb": { sort: "V" },
    "workspaceOrder/w1": true,
    "place/github.com%2Fa%2Fb/w1": { placementIndex: 0, sort: "V" },
    "workspaceOrder/w2": true,
    "place/github.com%2Fa%2Fb/w2": { placementIndex: 1, ordered: false, sort: "V" },
    "fold/w1/github.com%2Fa%2Fb": "active",
    "machine/env-1": { label: "Boreal", tag: "BO", reach: { "env-2": { ssh: "root@boreal" } } },
    "alias/env-2%3A%2Froot%2Fx": "github.com/a/b",
    "rep/github.com%2Fa%2Fb/env-1": {
      environmentId: "env-1",
      path: "/root/x",
      projectId: "p1",
      transport: "git",
      role: "primary",
    },
    "repstatus/github.com%2Fa%2Fb/env-1": {
      state: "watching",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    "legacy/alwaysShow": ["github.com/a/b"],
  });
});

NodeTest.test("legacy entries carry a zero clock so the server adopts workspace names", () => {
  const config = {
    workspaces: [{ id: "w", name: "W" }],
    assignments: {},
    placements: {},
    rules: [],
    defaultWorkspace: "w",
    projectOrder: [],
    workspaceProjectOrder: {},
    workspaceFold: {},
    quietAfterDays: 5,
    alwaysShow: [],
    alwaysQuiet: [],
    machines: {},
    projectAliases: {},
    projectMounts: {},
    projectMountStatus: {},
  };
  const entries = importLegacyEntries(config, "env-9");
  for (const entry of Object.values(entries)) {
    NodeAssert.match(entry.h, /^0000000000000\.00000\.env-9$/);
  }
});

NodeTest.test("argument builders and deep links are shared with the commands", () => {
  NodeAssert.equal(waitSeconds(true), 600);
  NodeAssert.equal(waitSeconds("90"), 90);
  NodeAssert.equal(waitSeconds("2m"), 120);
  NodeAssert.equal(waitSeconds("1h"), 600);
  NodeAssert.equal(waitSeconds(undefined), undefined);
  NodeAssert.equal(waitSeconds(false), undefined);

  NodeAssert.deepEqual(
    buildPlaceInput({
      project: "p",
      machine: "m",
      role: "replica",
      source: "s",
      path: "/x",
      wait: 30,
    }),
    { project: "p", machine: "m", role: "replica", source: "s", path: "/x", wait: 30 },
  );
  NodeAssert.deepEqual(
    buildMeshLinkInput({ url: "https://x", pairingCode: "c", environmentId: "e", label: "L" }),
    {
      url: "https://x",
      pairingCode: "c",
      access: "full-access",
      expectedEnvironmentId: "e",
      expectedLabel: "L",
    },
  );
  NodeAssert.deepEqual(buildUiOpenTarget({ kind: "thread", threadId: "t", environmentId: "e" }), {
    kind: "thread",
    threadId: "t",
    environmentId: "e",
  });
  NodeAssert.deepEqual(
    buildUiOpenTarget({ kind: "file", path: "/a b.md", line: 12, environmentId: "e" }),
    { kind: "file", path: "/a b.md", line: 12, environmentId: "e" },
  );
  NodeAssert.equal(threadDeepLink("e", "t"), "t3-thread://v2/e/t");
  NodeAssert.equal(threadWebUrl("http://127.0.0.1:3795/", "e", "t"), "http://127.0.0.1:3795/e/t");
  NodeAssert.equal(fileDeepLink("e", "/a b.md", 12), "t3-file://e/%2Fa%20b.md%3A12");
  NodeAssert.equal(defaultMachineTag("Boreal", "x"), "BO");
  NodeAssert.equal(defaultMachineTag("", "3rd machine"), "3R");
});

NodeTest.test("duplicate labels are ambiguous and server labels resolve", () => {
  NodeAssert.throws(
    () => resolveMachineRef("lab", [...MACHINES, { environmentId: "cccccccc", label: "lab" }]),
    /matches/,
  );
  NodeAssert.equal(
    resolveMachineRef("Custom Host", [{ ...MACHINES[0], serverLabel: "Custom Host" }]).label,
    "atlas",
  );
});
