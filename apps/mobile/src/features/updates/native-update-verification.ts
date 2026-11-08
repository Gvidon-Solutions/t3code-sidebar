import forge from "node-forge";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const Envelope = Schema.Struct({
  nativeUpdate: Schema.Struct({ payload: Schema.String, signature: Schema.String }),
});
const Payload = Schema.Struct({
  platform: Schema.Literal("android"),
  runtimeVersion: Schema.String,
  apkUrl: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(Payload));
export type VerifiedApk = typeof Payload.Type;

export function verifiedNativeUpdate(
  status: unknown,
  updateUrl: string,
  certificate: string,
  runtime: string,
): VerifiedApk | undefined {
  const envelope = decodeEnvelope(status);
  if (Option.isNone(envelope)) return undefined;
  const signed = envelope.value.nativeUpdate;
  const payload = decodePayload(signed.payload);
  if (Option.isNone(payload)) return undefined;
  const apk = payload.value;
  const url = URL.parse(apk.apkUrl);
  const origin = URL.parse(updateUrl);
  if (
    !url ||
    !origin ||
    url.protocol !== "https:" ||
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    apk.runtimeVersion === runtime
  )
    return undefined;
  const cert = forge.pki.certificateFromPem(certificate);
  const key = cert.publicKey;
  if (!("verify" in key)) throw new Error("OTA certificate requires an RSA public key");
  const digest = forge.md.sha256.create().update(signed.payload, "utf8").digest().getBytes();
  if (!key.verify(digest, forge.util.decode64(signed.signature))) return undefined;
  return apk;
}
