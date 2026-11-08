// @effect-diagnostics nodeBuiltinImport:off -- Tests create RSA/X509 fixtures with the protocol's native primitives.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ServerConfig, layerTest } from "../config.ts";
import { MobileOta, layer } from "./MobileOta.ts";
import { selectOtaRelease, verifyOtaRelease, type OtaRelease } from "./otaProtocol.ts";
const { execFileSync } = NodeChildProcess;
const { sign } = NodeCrypto;
const { mkdtempSync, readFileSync, rmSync } = NodeFS;
const { tmpdir } = NodeOS;
const { join } = NodePath;

function signingFixture() {
  const dir = mkdtempSync(join(tmpdir(), "mobile-ota-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "1",
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "extendedKeyUsage=codeSigning",
      "-subj",
      "/CN=Mobile OTA Test",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "certificate.pem"),
    ],
    { stdio: "ignore" },
  );
  return {
    key: readFileSync(join(dir, "key.pem")),
    certificate: readFileSync(join(dir, "certificate.pem"), "utf8"),
    [Symbol.dispose]() {
      rmSync(dir, { recursive: true });
    },
  };
}
function release(id: string, runtime: string, createdAt: string, key: Buffer): OtaRelease {
  const asset = {
    key: "bundle",
    hash: "A".repeat(43),
    contentType: "application/javascript",
    url: "https://studio.example/api/mobile-updates/assets/bundle",
    fileExtension: ".js",
  };
  const manifest = JSON.stringify({
    id,
    createdAt,
    runtimeVersion: runtime,
    launchAsset: asset,
    assets: [],
    metadata: { bundle: id },
    extra: {},
  });
  return {
    manifest,
    signature: sign("RSA-SHA256", Buffer.from(manifest), key).toString("base64"),
    platform: "android",
  };
}

describe("self-hosted mobile updates", () => {
  it("rejects tampered signatures and native runtime mismatches while retaining previous bundles", () => {
    using fixture = signingFixture();
    const first = release("first", "native-a", "2026-01-01T00:00:00Z", fixture.key);
    const second = release("second", "native-a", "2026-01-02T00:00:00Z", fixture.key);
    const incompatible = release("new-native", "native-b", "2026-01-03T00:00:00Z", fixture.key);
    const catalog = { releases: [incompatible, first, second] };
    expect(verifyOtaRelease(second, fixture.certificate).id).toBe("second");
    expect(() =>
      verifyOtaRelease(
        { ...second, manifest: second.manifest.replace("second", "forged") },
        fixture.certificate,
      ),
    ).toThrow("signature is invalid");
    expect(selectOtaRelease(catalog, "android", "native-a", false)).toEqual(second);
    expect(selectOtaRelease(catalog, "android", "native-unknown", false)).toBeUndefined();
    expect(selectOtaRelease(catalog, "ios", "native-a", false)).toBeUndefined();
    expect(selectOtaRelease(catalog, "android", "native-a", true, "second")).toEqual(first);
  });

  it.effect(
    "serves only verified compatible manifests, exposes native upgrade status and refuses unsafe assets",
    () =>
      Effect.gen(function* () {
        using fixture = signingFixture();
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const ota = yield* MobileOta;
        const root = join(config.baseDir, "mobile-updates");
        yield* fs.makeDirectory(root, { recursive: true });
        const first = release("first", "native-a", "2026-01-01T00:00:00Z", fixture.key);
        const second = release("second", "native-b", "2026-01-02T00:00:00Z", fixture.key);
        yield* fs.writeFileString(join(root, "certificate.pem"), fixture.certificate);
        yield* fs.writeFileString(
          join(root, "catalog.json"),
          JSON.stringify({
            releases: [first, second],
            apkUrl: "https://studio.example/app.apk",
            apkAsset: {
              key: "C".repeat(43),
              hash: "C".repeat(43),
              contentType: "application/vnd.android.package-archive",
              url: "https://studio.example/app.apk",
              fileExtension: "apk",
            },
          }),
        );
        const request = {
          "expo-protocol-version": "1",
          "expo-platform": "android",
          "expo-runtime-version": "native-a",
        };
        const compatible = yield* ota.manifest(request);
        expect(compatible.status).toBe(200);
        expect(compatible.headers["expo-signature"]).toContain(first.signature);
        expect(
          (yield* ota.manifest({ ...request, "expo-runtime-version": "native-c" })).status,
        ).toBe(204);
        expect((yield* ota.manifest({ ...request, "expo-protocol-version": "2" })).status).toBe(
          400,
        );
        expect((yield* ota.asset("../certificate.pem")).status).toBe(404);
        yield* fs.makeDirectory(join(root, "assets"));
        yield* fs.writeFileString(join(root, "assets", "A".repeat(43)), "bundle");
        expect((yield* ota.asset("A".repeat(43))).headers["content-type"]).toBe(
          "application/javascript",
        );
        expect((yield* ota.asset("B".repeat(43))).status).toBe(404);
        yield* fs.writeFileString(join(root, "assets", "C".repeat(43)), "signed-apk");
        expect((yield* ota.asset("C".repeat(43))).headers["content-type"]).toBe(
          "application/vnd.android.package-archive",
        );
        expect((yield* ota.asset("C".repeat(43))).headers["content-disposition"]).toBe(
          'attachment; filename="T3-Code-Sidebar.apk"',
        );
        const status = yield* ota.status("android", "native-a");
        expect(status.body._tag).toBe("Uint8Array");
        if (status.body._tag === "Uint8Array")
          expect(JSON.parse(new TextDecoder().decode(status.body.body))).toEqual({
            requiresNativeUpdate: true,
            apkUrl: "https://studio.example/app.apk",
          });
        yield* fs.writeFileString(
          join(root, "catalog.json"),
          JSON.stringify({ releases: [{ ...first, signature: second.signature }] }),
        );
        expect((yield* ota.manifest(request)).status).toBe(503);
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provideMerge(layerTest(process.cwd(), { prefix: "t3-mobile-ota-" })),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );
});
