// @effect-diagnostics nodeBuiltinImport:off -- Effect Crypto does not expose X509Certificate or RSA signature verification.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
const { verify, X509Certificate } = NodeCrypto;

export const OtaAsset = Schema.Struct({
  key: Schema.String,
  hash: Schema.String,
  contentType: Schema.String,
  url: Schema.String,
  fileExtension: Schema.String,
});
export const OtaManifest = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  runtimeVersion: Schema.String,
  launchAsset: OtaAsset,
  assets: Schema.Array(OtaAsset),
  metadata: Schema.Struct({ bundle: Schema.String }),
  extra: Schema.Record(Schema.String, Schema.Unknown),
});
export const OtaRelease = Schema.Struct({
  manifest: Schema.String,
  signature: Schema.String,
  platform: Schema.Literals(["android", "ios"]),
});
export const OtaCatalog = Schema.Struct({
  releases: Schema.Array(OtaRelease),
  apkUrl: Schema.optional(Schema.String),
});
const decodeManifest = Schema.decodeSync(Schema.fromJsonString(OtaManifest));
export type OtaRelease = typeof OtaRelease.Type;
export type OtaCatalog = typeof OtaCatalog.Type;

export function verifyOtaRelease(release: OtaRelease, certificate: string) {
  const manifest = decodeManifest(release.manifest);
  const signer = new X509Certificate(certificate);
  if (!signer.keyUsage?.includes("1.3.6.1.5.5.7.3.3"))
    throw new Error("Mobile update certificate must have Code Signing usage");
  if (
    !verify(
      "RSA-SHA256",
      Buffer.from(release.manifest),
      signer.publicKey,
      Buffer.from(release.signature, "base64"),
    )
  ) {
    throw new Error("Mobile update manifest signature is invalid");
  }
  return manifest;
}

export function selectOtaRelease(
  catalog: OtaCatalog,
  platform: string,
  runtime: string,
  previous: boolean,
  currentId?: string,
) {
  const compatible = catalog.releases
    .map((release) => ({
      release,
      manifest: decodeManifest(release.manifest),
    }))
    .filter(
      ({ release, manifest }) =>
        release.platform === platform && manifest.runtimeVersion === runtime,
    )
    .toSorted((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
  if (!previous) return compatible[0]?.release;
  const currentIndex = compatible.findIndex(({ manifest }) => manifest.id === currentId);
  return compatible[(currentIndex < 0 ? 0 : currentIndex) + 1]?.release;
}
