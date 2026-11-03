import { expect, it, vi } from "vite-plus/test";
import {
  draftMachineDisplays,
  draftMachineStatus,
  logDraftMachineCollisions,
} from "./draftMachineChoices.ts";

it("distinguishes isolated servers sharing a hostname and deduplicates one environment", () => {
  const machines = [
    { environmentId: "old", label: "gvidon", url: "http://10.0.2.2:3795" },
    { environmentId: "other", descriptorLabel: "gvidon", url: "http://10.0.2.2:3805" },
    { environmentId: "current", descriptorLabel: "gvidon", url: "http://10.0.2.2:16155" },
  ];
  const result = draftMachineDisplays({ machines: {} }, [...machines, machines[0]!]);
  expect(result.rows.map((row) => row.label)).toEqual([
    "gvidon (10.0.2.2:3795)",
    "gvidon (10.0.2.2:3805)",
    "gvidon (10.0.2.2:16155)",
  ]);
  expect(result.collisions).toEqual([
    { label: "gvidon", environmentIds: ["current", "old", "other"] },
  ]);
});
it("prefers the layout name, then descriptor; distinct layout tags disambiguate before endpoints", () => {
  const result = draftMachineDisplays(
    { machines: { a: { label: "Server", tag: "OP" }, b: { label: "Server", tag: "GV" } } },
    [
      { environmentId: "a", descriptorLabel: "Operalia", label: "stale" },
      { environmentId: "b", descriptorLabel: "gvidon" },
    ],
  );
  expect(result.rows.map((row) => [row.tag, row.label])).toEqual([
    ["OP", "Server (OP)"],
    ["GV", "Server (GV)"],
  ]);
  expect(
    draftMachineDisplays({ machines: {} }, [
      { environmentId: "a", label: "old", descriptorLabel: "Operalia" },
    ]).rows[0]?.label,
  ).toBe("Operalia");
});
it("never prints opaque ids even when two stale connections have no usable endpoint", () => {
  const rows = draftMachineDisplays({ machines: {} }, [
    { environmentId: "opaque-a", label: "Server" },
    { environmentId: "opaque-b", label: "Server" },
  ]).rows;
  expect(new Set(rows.map((row) => row.label)).size).toBe(2);
  expect(rows.map((row) => row.label).join()).not.toContain("opaque");
  expect(draftMachineStatus({ connected: true, hasProject: true })).toBe("here");
  expect(draftMachineStatus({ connected: true, hasProject: false })).toBe("copy will be created");
  expect(draftMachineStatus({ connected: false, hasProject: true })).toBe("not connected");
  expect(
    draftMachineStatus({ connected: false, hasProject: true, error: "connection refused" }),
  ).toBe("unreachable · connection refused");
  expect(
    draftMachineStatus({
      connected: false,
      hasProject: false,
      error: "Failed to fetch remote environment endpoint http://host:1234",
    }),
  ).toBe("unreachable · connection failed");
  expect(
    draftMachineStatus({ connected: false, hasProject: false, error: "Machine did not answer" }),
  ).toBe("unreachable · no response");
});

it("logs a label collision once without silently merging distinct machines", () => {
  const warn = vi.fn();
  const collisions = [{ label: "collision-test", environmentIds: ["a", "b"] }];
  logDraftMachineCollisions(collisions, warn);
  logDraftMachineCollisions(collisions, warn);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith("[mesh] Duplicate machine labels disambiguated", collisions);
});
