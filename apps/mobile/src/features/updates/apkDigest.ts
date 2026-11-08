import forge from "node-forge";

export function createApkDigest() {
  const digest = forge.md.sha256.create();
  return {
    update(bytes: Uint8Array) {
      // Forge's raw encoder spreads bytes as function arguments.
      for (let offset = 0; offset < bytes.length; offset += 16 * 1024)
        digest.update(forge.util.binary.raw.encode(bytes.subarray(offset, offset + 16 * 1024)));
    },
    hex: () => digest.digest().toHex(),
  };
}
