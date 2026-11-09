import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FILES_LIST_MAX_LIMIT,
  FILES_LOCATE_MAX_CANDIDATES,
  FILES_PATH_MAX_LENGTH,
  FILES_READ_BYTES_MAX,
  FilesError,
  FilesListInput,
  FilesListResult,
  FilesLocateInput,
  FilesLocateResult,
  FilesReadBytesInput,
  FilesReadBytesResult,
  FilesReadInput,
  FilesReadResult,
  FilesStatInput,
  FilesStatResult,
} from "./files.ts";

const decodeRead = Schema.decodeUnknownSync(FilesReadInput);
const decodeList = Schema.decodeUnknownSync(FilesListInput);
const decodeReadResult = Schema.decodeUnknownSync(FilesReadResult);
const decodeListResult = Schema.decodeUnknownSync(FilesListResult);
const decodeFilesError = Schema.decodeUnknownSync(FilesError);
const decodeLocate = Schema.decodeUnknownSync(FilesLocateInput);
const decodeLocateResult = Schema.decodeUnknownSync(FilesLocateResult);
const decodeStat = Schema.decodeUnknownSync(FilesStatInput);
const decodeStatResult = Schema.decodeUnknownSync(FilesStatResult);
const decodeReadBytes = Schema.decodeUnknownSync(FilesReadBytesInput);
const decodeReadBytesResult = Schema.decodeUnknownSync(FilesReadBytesResult);

describe("files contracts", () => {
  it("decodes an absolute path with and without a machine", () => {
    expect(decodeRead({ absolutePath: " /srv/app/README.md " })).toEqual({
      absolutePath: "/srv/app/README.md",
    });
    expect(decodeRead({ environmentId: "studio", absolutePath: "~/note.md" })).toEqual({
      environmentId: "studio",
      absolutePath: "~/note.md",
    });
  });

  it("rejects blank and over-long paths, and too many list results", () => {
    expect(() => decodeRead({ absolutePath: "  " })).toThrow();
    expect(() => decodeRead({ absolutePath: "x".repeat(FILES_PATH_MAX_LENGTH + 1) })).toThrow();
    expect(() => decodeList({ partialPath: "/srv", limit: FILES_LIST_MAX_LIMIT + 1 })).toThrow();
  });

  it("round-trips a read result with and without a mime type", () => {
    expect(
      decodeReadResult({
        absolutePath: "/srv/app/README.md",
        contents: "# App\n",
        byteLength: 6,
        truncated: false,
      }),
    ).toEqual({
      absolutePath: "/srv/app/README.md",
      contents: "# App\n",
      byteLength: 6,
      truncated: false,
    });
    expect(
      decodeReadResult({
        absolutePath: "/srv/app/logo.png",
        contents: "",
        byteLength: 12,
        truncated: true,
        mimeType: "image/png",
      }).mimeType,
    ).toBe("image/png");
  });

  it("round-trips list entries", () => {
    expect(
      decodeListResult({
        parentPath: "/srv/app",
        entries: [
          { name: "src", absolutePath: "/srv/app/src", kind: "directory" },
          { name: "README.md", absolutePath: "/srv/app/README.md", kind: "file" },
        ],
      }).entries,
    ).toHaveLength(2);
  });

  it("derives a stable message per failure while keeping the cause", () => {
    const cause = new Error("EACCES: permission denied, open '/root/secret'");
    const error = new FilesError({
      reason: "permission_denied",
      absolutePath: "/root/secret",
      cause,
    });
    expect(error.message).toBe("This machine does not allow reading that path.");
    expect(error.message).not.toContain(cause.message);
    expect(error.cause).toBe(cause);
    expect(new FilesError({ reason: "not_found" }).message).toBe(
      "The file or folder was not found.",
    );
  });

  it("decodes a locate request and a found result with its machine and tier", () => {
    expect(decodeLocate({ rawPath: "src/lib/x.ts", intent: "open" })).toEqual({
      rawPath: "src/lib/x.ts",
      intent: "open",
    });
    const result = decodeLocateResult({
      status: "found",
      environmentId: "studio",
      target: {
        environmentId: "cloudbox",
        absolutePath: "/srv/app/src/lib/x.ts",
        kind: "file",
        via: "representation-map",
        inProject: true,
        notSynced: true,
        touchedByThread: false,
        displayPath: "src/lib/x.ts",
        line: 12,
      },
      tried: [{ tier: "exact", environmentId: "studio" }],
      projectTitle: "App",
    });
    expect(result.target?.environmentId).toBe("cloudbox");
    expect(result.target?.line).toBe(12);
  });

  it("caps stat and read-bytes inputs", () => {
    expect(decodeStat({ absolutePath: " /srv/a " })).toEqual({ absolutePath: "/srv/a" });
    expect(() => decodeReadBytes({ absolutePath: "/srv/a", offset: 0, length: 1 })).not.toThrow();
    expect(() =>
      decodeReadBytes({ absolutePath: "/srv/a", offset: 0, length: FILES_READ_BYTES_MAX + 1 }),
    ).toThrow();
    expect(() => decodeReadBytes({ absolutePath: "/srv/a", offset: -1, length: 1 })).toThrow();
    expect(
      decodeStatResult({ absolutePath: "/srv/a", kind: "file", byteLength: 3, mtimeMs: 1.5 }).kind,
    ).toBe("file");
    expect(
      decodeReadBytesResult({ absolutePath: "/srv/a", offset: 0, bytes: "AA==", totalBytes: 1 })
        .totalBytes,
    ).toBe(1);
  });

  it("publishes the candidate cap", () => {
    expect(FILES_LOCATE_MAX_CANDIDATES).toBeGreaterThan(0);
  });

  it("decodes a legacy message-only failure during rolling upgrades", () => {
    const legacy: unknown = {
      _tag: "FilesError",
      reason: "operation_failed",
      message: "Legacy file failure.",
    };
    const error = decodeFilesError(legacy);
    expect(error.message).toBe("Legacy file failure.");
    expect(error.absolutePath).toBeUndefined();
  });
});
