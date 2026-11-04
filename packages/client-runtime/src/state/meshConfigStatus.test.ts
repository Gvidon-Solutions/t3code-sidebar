import { expect, it } from "vite-plus/test";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type MeshConfigRevision,
  type MeshConfigStatus,
  type ReplicaLiveStatus,
} from "@t3tools/contracts";
import { buildMeshMachines } from "./meshMachines.ts";
import { meshConfigApplyGroups, meshMachineDetailRows } from "./meshConfigStatus.ts";

it("groups apply results by revision, deduplicates reports, and retains readable failures", () => {
  const history: MeshConfigRevision[] = [
    {
      revision: "internal-clock",
      sequence: 12,
      writtenAt: "2026-11-05T00:00:00Z",
      author: "studio",
      doc: { schema: 1, machines: {} },
    },
  ];
  const actions: MeshConfigStatus["servers"][number]["actions"] = [
    { id: "label", server: "studio", description: "Machine label GV → Studio", state: "done" },
    {
      id: "replica",
      server: "studio",
      description: "Replica of Field notes on Cloudbox",
      state: "done",
    },
    { id: "ssh", server: "studio", description: "SSH access for Cloudbox", state: "done" },
    {
      id: "version",
      server: "studio",
      description: "Update Cloudbox",
      state: "failed",
      reason: "Download checksum did not match",
    },
  ];
  const groups = meshConfigApplyGroups(
    {
      servers: [
        { environmentId: "studio", revision: "internal-clock", actions },
        { environmentId: "cloudbox", revision: "internal-clock", actions },
      ],
    },
    history,
    Date.parse("2026-11-05T00:02:00Z"),
  );
  expect(groups).toHaveLength(1);
  expect(groups[0]?.title).toBe("Config r12 applied 2 min ago · 3 changes done, 1 failed");
  expect(groups[0]?.actions).toEqual(actions);
  expect(JSON.stringify(groups.map((group) => group.title))).not.toContain("internal-clock");
});
it("shows replica lag and SSH route reasons while keeping absent reports unknown", () => {
  const config = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    projectTitles: { notes: "Field notes" },
    machines: {
      studio: { title: "Studio" },
      cloudbox: {
        title: "Cloudbox",
        reported: {
          version: "1.5",
          user: null,
          sshd: null,
          platform: { os: "linux", arch: "x64", release: "test" },
          reportedAt: "2026-11-05T00:00:00Z",
          sshRoutes: {
            studio: {
              status: "failed" as const,
              reason: "Host key changed",
              checkedAt: "2026-11-05T00:01:00Z",
            },
          },
        },
      },
    },
    projectMounts: {
      notes: [
        {
          environmentId: "cloudbox",
          source: "studio",
          role: "replica" as const,
          transport: "mutagen" as const,
          path: "/notes",
          createdAt: "",
        },
      ],
    },
  };
  const machine = buildMeshMachines({ config }).find(
    (machine) => machine.environmentId === "cloudbox",
  )!;
  const live: ReplicaLiveStatus[] = [
    {
      logicalKey: "notes",
      environmentId: "cloudbox",
      state: "watching",
      conflicts: [],
      problems: [],
      updatedAt: "",
      lag: { filesBehind: 3, bytesBehind: 64 },
    },
  ];
  expect(meshMachineDetailRows(machine, config, live)).toEqual([
    { label: "SSH to Studio", value: "Failed · Host key changed · checked 2026-11-05T00:01:00Z" },
    { label: "Field notes", value: "watching · 3 files behind · 64 bytes behind" },
  ]);
  expect(
    meshMachineDetailRows(machine, config, [
      { ...live[0]!, state: "error", problems: ["Permission denied"] },
    ])[1]?.value,
  ).toContain("Permission denied");
  expect(meshMachineDetailRows(machine, config, [])[1]?.value).toContain("Lag not reported");
});
