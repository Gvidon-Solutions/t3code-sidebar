// @effect-diagnostics nodeBuiltinImport:off -- The integration fixture prepares a verified archive before entering the test clock and test deadline.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

export async function mutagenArchive(platform: NodeJS.Platform, architecture: string) {
  const target = `${platform === "win32" ? "windows" : platform}_${architecture === "x64" ? "amd64" : architecture}`;
  const checksums: Record<string, string> = {
    linux_amd64: "7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f",
    linux_arm64: "bcba735aebf8cbc11da9b3742118a665599ac697fa06bc5751cac8dcd540db8a",
    darwin_amd64: "7d06f7d8fcfe90bc7e55cc834a2f2f20c2e0af9ea9bc35911fc4341ad56a9bbf",
    darwin_arm64: "6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2",
    windows_amd64: "3e237e77f69959ed520a0f877330a431507bb0a85d9da7919764ba0c87b702c7",
    windows_arm64: "9ac53447e46f019be9d37f49c00eeed8635966b885ed29ef06b3ff19afdee532",
  };
  const expected = checksums[target];
  if (!expected) throw new Error(`No Mutagen fixture for ${target}`);
  const directory = NodePath.resolve(
    import.meta.dirname,
    "../../../../node_modules/.cache/t3-mutagen-fixtures",
  );
  const file = NodePath.join(directory, `${target}-0.18.1.tar.gz`);
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
          `https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/mutagen_${target}_v0.18.1.tar.gz`,
        ],
      );
      bytes = await NodeFSP.readFile(temporary);
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
    if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error("Mutagen fixture checksum mismatch");
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(file, bytes);
  }
  if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("Cached Mutagen fixture checksum mismatch");
  return bytes;
}
