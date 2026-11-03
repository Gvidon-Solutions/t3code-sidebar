import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addRecentFile,
  buildT3FileLink,
  machineTag,
  parseT3FileLink,
  pickFilesEnvironment,
} from "./files.ts";

const here = "env-here" as EnvironmentId;
const there = "env-there" as EnvironmentId;

describe("machineTag", () => {
  it("uses the same short-label rule as sidebar machine tags", () => {
    expect(machineTag("gvidon")).toBe("GV");
    expect(machineTag("Operalia")).toBe("OP");
    expect(machineTag("gor")).toBe("GOR");
    expect(machineTag("my box")).toBe("MY");
    expect(machineTag("x")).toBe("X");
    expect(machineTag("v-p-s")).toBe("VPS");
  });
});

describe("pickFilesEnvironment", () => {
  it("uses the target when connected and otherwise a connected forwarder", () => {
    expect(pickFilesEnvironment(there, [here, there])).toBe(there);
    expect(pickFilesEnvironment(there, [here])).toBe(here);
    expect(pickFilesEnvironment(there, [])).toBeNull();
  });
});

describe("t3-file links", () => {
  it("round-trips an absolute path", () => {
    const link = buildT3FileLink(there, "/srv/app/README.md");
    expect(link).toBe("t3-file://env-there/%2Fsrv%2Fapp%2FREADME.md");
    expect(parseT3FileLink(link)).toEqual({
      environmentId: there,
      absolutePath: "/srv/app/README.md",
    });
  });

  it("accepts a pasted link with separators left alone", () => {
    expect(parseT3FileLink("t3-file://env-there//srv/app/README.md")).toEqual({
      environmentId: there,
      absolutePath: "/srv/app/README.md",
    });
  });

  it("supports Windows absolute paths", () => {
    const link = buildT3FileLink(there, "C:\\work\\README.md");
    expect(parseT3FileLink(link)).toEqual({
      environmentId: there,
      absolutePath: "C:\\work\\README.md",
    });
  });

  it("rejects other URLs and malformed escapes", () => {
    expect(parseT3FileLink("https://example.com/file")).toBeNull();
    expect(parseT3FileLink("t3-file://")).toBeNull();
    expect(parseT3FileLink("t3-file://env/%E0%A4%A")).toBeNull();
  });
});

describe("addRecentFile", () => {
  it("moves a path to the front and bounds the list", () => {
    expect(addRecentFile(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
    expect(addRecentFile(["/a", "/b", "/c"], "/d", 2)).toEqual(["/d", "/a"]);
  });
});
