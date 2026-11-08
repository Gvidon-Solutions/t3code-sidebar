import { expect, it } from "vite-plus/test";
import forge from "node-forge";
import { verifiedNativeUpdate } from "./native-update-verification";

it("offers only a same-origin APK whose URL, digest and runtime are signed by the pinned OTA key", () => {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.setSubject([{ name: "commonName", value: "OTA test" }]);
  cert.setIssuer(cert.subject.attributes);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certificate = forge.pki.certificateToPem(cert);
  const apk = {
    platform: "android",
    runtimeVersion: "next",
    apkUrl: "https://updates.example/app.apk",
    sha256: "a".repeat(64),
  };
  const signed = (value: typeof apk) => {
    const payload = JSON.stringify(value);
    return {
      nativeUpdate: {
        payload,
        signature: forge.util.encode64(
          keys.privateKey.sign(forge.md.sha256.create().update(payload, "utf8")),
        ),
      },
    };
  };
  const status = signed(apk);
  expect(
    verifiedNativeUpdate(status, "https://updates.example/manifest", certificate, "current"),
  ).toEqual(apk);
  expect(
    verifiedNativeUpdate(status, "https://other.example/manifest", certificate, "current"),
  ).toBeUndefined();
  expect(
    verifiedNativeUpdate(status, "https://updates.example/manifest", certificate, "next"),
  ).toBeUndefined();
  for (const value of [
    { ...apk, apkUrl: "https://evil.example/a.apk" },
    { ...apk, apkUrl: "http://updates.example/a.apk" },
    { ...apk, sha256: "invalid" },
  ])
    expect(
      verifiedNativeUpdate(
        signed(value),
        "https://updates.example/manifest",
        certificate,
        "current",
      ),
    ).toBeUndefined();
  for (const payload of [
    status.nativeUpdate.payload.replace("app.apk", "evil.apk"),
    status.nativeUpdate.payload.replace("a".repeat(64), "b".repeat(64)),
  ])
    expect(
      verifiedNativeUpdate(
        { nativeUpdate: { ...status.nativeUpdate, payload } },
        "https://updates.example/manifest",
        certificate,
        "current",
      ),
    ).toBeUndefined();
  expect(
    verifiedNativeUpdate(
      { requiresNativeUpdate: true, apkUrl: apk.apkUrl },
      "https://updates.example",
      certificate,
      "current",
    ),
  ).toBeUndefined();
});
