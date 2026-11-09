import { describe, expect, it } from "vite-plus/test";

import { defaultLinkSource } from "./linkSource.ts";

const sources = [{ environmentId: "cloudbox" }, { environmentId: "studio" }];

describe("defaultLinkSource", () => {
  it("starts from this machine even when another machine comes first", () => {
    expect(defaultLinkSource(sources, "studio")).toBe("studio");
  });

  it("keeps the first machine when this machine cannot link", () => {
    expect(defaultLinkSource(sources, "laptop")).toBe("cloudbox");
    expect(defaultLinkSource(sources, null)).toBe("cloudbox");
    expect(defaultLinkSource([], "studio")).toBeNull();
  });
});
