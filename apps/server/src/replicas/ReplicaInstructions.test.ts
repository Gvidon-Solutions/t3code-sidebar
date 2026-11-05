import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { replicaContextNote, threadContextNote } from "./ReplicaInstructions.ts";
it("injects identity on primary and replica turns within 600 UTF-8 bytes", () => {
  for (const note of [
    "",
    "This is a synchronized replica. Git and builds run on the primary. " + "я".repeat(1000),
  ]) {
    const context = threadContextNote("mcp:thread", "machine", note);
    expect(context).toContain("mcp:thread");
    expect(context).toContain("machine");
    expect(context).toContain("Call t3_thread_self for details");
    expect(new TextEncoder().encode(context).length).toBeLessThanOrEqual(600);
    expect(context).toContain(note ? "primary" : "primary on this machine");
    const longIdentity = threadContextNote("t".repeat(2000), "м".repeat(2000), note);
    expect(new TextEncoder().encode(longIdentity).length).toBeLessThanOrEqual(600);
    expect(longIdentity).toContain("Call t3_thread_self for details");
  }
  const orphanNote = replicaContextNote(
    {
      ...DEFAULT_SERVER_SETTINGS.sidebarWorkspaces,
      projectMounts: {
        repo: [
          {
            environmentId: "replica",
            projectId: "project",
            path: "/copy",
            role: "replica",
            transport: "mutagen",
            source: "missing",
            createdAt: "",
          },
        ],
      },
    },
    "replica",
    "project",
  );
  expect(orphanNote).toContain("replica");
  expect(orphanNote).toContain("unavailable");
  expect(threadContextNote("thread", "replica", orphanNote)).not.toContain(
    "primary on this machine",
  );
});

it("names the primary machine in the injected note instead of presenting its id as a name", () => {
  const config = {
    ...DEFAULT_SERVER_SETTINGS.sidebarWorkspaces,
    machines: {
      "opaque-primary": { label: "worker", tag: "WK" },
      replica: {},
    },
    projectMounts: {
      logical: [
        {
          environmentId: "opaque-primary",
          path: "/primary",
          role: "primary",
          transport: "git",
          createdAt: "",
        },
        {
          environmentId: "replica",
          projectId: "p",
          path: "/copy",
          role: "replica",
          transport: "mutagen",
          source: "opaque-primary",
          createdAt: "",
        },
      ],
    },
  } as const;
  const note = replicaContextNote(config, "replica", "p");
  expect(note).toContain("primary: worker (WK)");
  expect(note).toContain("mode: lite");
  expect(note).toContain("sync: pending");
  expect(note).not.toContain("opaque-primary");
  expect(note).toContain("t3 run -- <command>");
});
