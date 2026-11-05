import { expect, it, vi } from "vite-plus/test";
import {
  draftMachineDisplays,
  draftMachineStatus,
  logDraftMachineCollisions,
} from "./draftMachineChoices.ts";

it("distinguishes isolated servers sharing a hostname and deduplicates one environment", () => {
  const machines = [
    { environmentId: "old", label: "atlas", url: "http://10.0.2.2:3795" },
    { environmentId: "other", descriptorLabel: "atlas", url: "http://10.0.2.2:3805" },
    { environmentId: "current", descriptorLabel: "atlas", url: "http://10.0.2.2:16155" },
  ];
  const result = draftMachineDisplays({ machines: {} }, [...machines, machines[0]!]);
  expect(result.rows.map((row) => row.label)).toEqual([
    "atlas (10.0.2.2:3795)",
    "atlas (10.0.2.2:3805)",
    "atlas (10.0.2.2:16155)",
  ]);
  expect(result.collisions).toEqual([
    { label: "atlas", environmentIds: ["current", "old", "other"] },
  ]);
});
it("prefers the layout name, then descriptor; distinct layout tags disambiguate before endpoints", () => {
  const result = draftMachineDisplays(
    { machines: { a: { label: "Server", tag: "BO" }, b: { label: "Server", tag: "AT" } } },
    [
      { environmentId: "a", descriptorLabel: "Boreal", label: "stale" },
      { environmentId: "b", descriptorLabel: "atlas" },
    ],
  );
  expect(result.rows.map((row) => [row.tag, row.label])).toEqual([
    ["BO", "Server (BO)"],
    ["AT", "Server (AT)"],
  ]);
  expect(
    draftMachineDisplays({ machines: {} }, [
      { environmentId: "a", label: "old", descriptorLabel: "Boreal" },
    ]).rows[0]?.label,
  ).toBe("Boreal");
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

it("shows platform and short host for identical titles in web and native picker data", () => {
  const reported = (os: string) => ({
    version: "1",
    platform: { os, arch: "x64", release: "test" },
    user: null,
    sshd: null,
    reportedAt: "2026-01-01T00:00:00Z",
  });
  const result = draftMachineDisplays(
    {
      machines: {
        a: { title: "Studio", reported: reported("linux") },
        b: { title: "Studio", reported: reported("darwin") },
      },
    },
    [
      { environmentId: "a", url: "https://desk.example:3795" },
      { environmentId: "b", url: "https://laptop.example:3795" },
    ],
  );
  expect(result.rows.map((row) => row.label)).toEqual([
    "Studio (linux · desk:3795)",
    "Studio (darwin · laptop:3795)",
  ]);
});
