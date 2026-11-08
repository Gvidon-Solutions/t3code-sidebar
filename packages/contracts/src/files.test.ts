import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FILES_LIST_MAX_LIMIT,
  FILES_PATH_MAX_LENGTH,
  FilesError,
  FilesListInput,
  FilesListResult,
  FilesReadInput,
  FilesReadResult,
} from "./files.ts";

const decodeRead = Schema.decodeUnknownSync(FilesReadInput);
const decodeList = Schema.decodeUnknownSync(FilesListInput);
const decodeReadResult = Schema.decodeUnknownSync(FilesReadResult);
const decodeListResult = Schema.decodeUnknownSync(FilesListResult);
const decodeFilesError = Schema.decodeUnknownSync(FilesError);

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
