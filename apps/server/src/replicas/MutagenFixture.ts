// @effect-diagnostics nodeBuiltinImport:off -- The integration fixture prepares a verified archive before entering the test clock and test deadline.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  mutagenTarget,
  mutagenChecksums,
  mutagenArchiveName,
  mutagenReleaseUrl,
} from "../platform/mutagenRelease.ts";
import * as NodeCrypto from "node:crypto";

export async function mutagenArchive(platform: NodeJS.Platform, architecture: string) {
  const target = mutagenTarget(platform, architecture);
  const expected = mutagenChecksums[target];
  if (!expected) throw new Error(`No Mutagen fixture for ${target}`);
  const directory = NodePath.resolve(
    import.meta.dirname,
    "../../../../node_modules/.cache/t3-mutagen-fixtures",
  );
  const file = NodePath.join(directory, mutagenArchiveName(target));
  let bytes: Uint8Array;
  try {
    bytes = await NodeFSP.readFile(file);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await NodeFSP.mkdir(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.download`;
    try {
      await NodeUtil.promisify(NodeChildProcess.execFile)(
        platform === "win32" ? "curl.exe" : "curl",
        [
          "--fail",
          "--location",
          "--connect-timeout",
          "10",
          "--max-time",
          "30",
          "--output",
          temporary,
          mutagenReleaseUrl(target),
        ],
      );
      bytes = await NodeFSP.readFile(temporary);
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
    if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error("Mutagen fixture checksum mismatch", { cause: error });
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(file, bytes);
  }
  if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("Cached Mutagen fixture checksum mismatch");
  return bytes;
}
