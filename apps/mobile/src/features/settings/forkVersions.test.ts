import { describe, expect, it } from "vite-plus/test";

import { compareForkVersionsNewestFirst, downloadPercent } from "./forkVersions";

describe("compareForkVersionsNewestFirst", () => {
  it("orders by build number, not as text", () => {
    const versions = [
      "0.0.45-sidebar.9",
      "0.0.45-sidebar.8",
      "0.0.45-sidebar.14",
      "0.0.46-sidebar.1",
      "0.0.45-sidebar.10",
    ];
    expect(versions.toSorted(compareForkVersionsNewestFirst)).toEqual([
      "0.0.46-sidebar.1",
      "0.0.45-sidebar.14",
      "0.0.45-sidebar.10",
      "0.0.45-sidebar.9",
      "0.0.45-sidebar.8",
    ]);
  });
});

describe("downloadPercent", () => {
  it("rounds down and waits for a known size", () => {
    expect(downloadPercent({ bytesWritten: 37_900, totalBytes: 100_000 })).toBe(37);
    expect(downloadPercent({ bytesWritten: 5, totalBytes: -1 })).toBeNull();
  });
});
