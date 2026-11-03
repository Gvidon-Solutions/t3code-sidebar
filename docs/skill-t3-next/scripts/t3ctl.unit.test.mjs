// Offline checks for the mesh argument parsing, machine resolver and legacy layout encoding.
// Run with: node --test scripts/t3ctl.unit.test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  buildMeshLinkInput,
  buildPlaceInput,
  meshProjectTitle,
  meshAuthorityEdit,
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
    environmentId: "a714f2fb-3139-4661-ae0a-6fbcaf76e853",
    label: "gvidon",
    tag: "GV",
    sshAlias: "gvidon",
  },
  {
    environmentId: "34e33796-4717-4293-a955-88c2f740db4d",
    label: "gor",
    tag: "GO",
    sshAlias: "gor",
  },
  {
    environmentId: "7c65a175-ae89-41e0-82d9-8cbd3d2d7e39",
    label: "Operalia",
    tag: "OP",
    sshAlias: "root@operalia",
  },
];

NodeTest.test("parseArgs keeps values, repeatable --from and optional --wait duration", () => {
  const a = parseArgs(["--on", "гор", "--wait", "90", "--yes", "status"]);
  NodeAssert.deepEqual(a.pos, ["status"]);
  NodeAssert.equal(a.opt.on, "гор");
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

NodeTest.test("machine names cover ids, labels, tags, ssh aliases and Russian voice forms", () => {
  NodeAssert.equal(resolveMachineRef("гвидон", MACHINES).label, "gvidon");
  NodeAssert.equal(resolveMachineRef("на горе", MACHINES).label, "gor");
  NodeAssert.equal(resolveMachineRef("гора", MACHINES).label, "gor");
  NodeAssert.equal(resolveMachineRef("опералия", MACHINES).label, "Operalia");
  NodeAssert.equal(resolveMachineRef("OP", MACHINES).label, "Operalia");
  NodeAssert.equal(resolveMachineRef("root@operalia", MACHINES).label, "Operalia");
  NodeAssert.equal(resolveMachineRef("34e3", MACHINES).label, "gor");
  NodeAssert.equal(resolveMachineRef("gvidon", MACHINES).label, "gvidon");
  NodeAssert.equal(normalizeMachineName("На горе"), "нагоре");
  NodeAssert.throws(() => resolveMachineRef("нет такой", MACHINES), /no machine/);
});

NodeTest.test("an exact label wins over a longer different machine", () => {
  const machines = [
    ...MACHINES,
    { environmentId: "11111111-1111-1111-1111-111111111111", label: "gor-old", tag: "G2" },
  ];
  NodeAssert.equal(resolveMachineRef("gor", machines).label, "gor");
  NodeAssert.equal(resolveMachineRef("gor-old", machines).label, "gor-old");
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
      "env-1": { label: "Operalia", tag: "OP", reach: { "env-2": { ssh: "root@operalia" } } },
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
    "machine/env-1": { label: "Operalia", tag: "OP", reach: { "env-2": { ssh: "root@operalia" } } },
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
  NodeAssert.equal(defaultMachineTag("Operalia", "x"), "OP");
  NodeAssert.equal(defaultMachineTag("", "3rd machine"), "3R");
});

NodeTest.test("duplicate labels are ambiguous and server labels resolve", () => {
  NodeAssert.throws(
    () => resolveMachineRef("gor", [...MACHINES, { environmentId: "cccccccc", label: "gor" }]),
    /matches/,
  );
  NodeAssert.equal(
    resolveMachineRef("Custom Host", [{ ...MACHINES[0], serverLabel: "Custom Host" }]).label,
    "gvidon",
  );
});

NodeTest.test("mesh display names never expose logical or legacy keys", () => {
  for (const key of ["opaque-123", "github.com/owner/repo", "env:/path", "title:legacy"]) {
    NodeAssert.equal(meshProjectTitle({}, key, "/home/user/Project"), "Project");
    NodeAssert.equal(
      meshProjectTitle({ projectTitles: { [key]: "Renamed" } }, key, "/Project"),
      "Renamed",
    );
    NodeAssert.equal(meshProjectTitle({}, key, "/"), "Untitled project");
  }
});
NodeTest.test(
  "authority edits advance past a future remote clock without electing a CLI device",
  () => {
    const edit = meshAuthorityEdit(
      {
        environmentId: "server",
        document: { "mesh.authority": { h: "9999999999000.99999.remote", v: "old" } },
      },
      "new",
      1,
    );
    NodeAssert.deepEqual(edit.entries["mesh.authority"], {
      h: "9999999999001.00000.server",
      v: "new",
    });
  },
);

NodeTest.test("place retains repeated ignore patterns and the requested transport", () => {
  const parsed = parseArgs([
    "Project",
    "--on",
    "OP",
    "--ignore",
    "*.tmp",
    "--ignore",
    "cache",
    "--transport",
    "manual",
  ]);
  NodeAssert.deepEqual(parsed.opt.ignore, ["*.tmp", "cache"]);
  NodeAssert.deepEqual(
    buildPlaceInput({
      project: "p",
      machine: "op",
      ignores: parsed.opt.ignore,
      transport: parsed.opt.transport,
    }),
    { project: "p", machine: "op", ignores: ["*.tmp", "cache"], transport: "manual" },
  );
});
