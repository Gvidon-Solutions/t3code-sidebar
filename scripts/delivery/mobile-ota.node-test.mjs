import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import { publishMobileUpdate } from "./mobile-ota.mjs";
const { test } = NodeTest;
const { mkdtemp, writeFile, mkdir, readFile, rm } = NodeFSP;
const { tmpdir } = NodeOS;
const { join } = NodePath;
const { execFileSync } = NodeChildProcess;
const { X509Certificate, verify } = NodeCrypto;

test("publishes real Expo exports, keeps two signed updates and refuses mismatched signing keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "ota-publish-"));
  try {
    const source = join(root, "export");
    await mkdir(source);
    const store = join(root, "store");
    await writeFile(
      join(source, "metadata.json"),
      JSON.stringify({
        fileMetadata: {
          android: { bundle: "bundle.js", assets: [{ path: "image.png", ext: "png" }] },
        },
      }),
    );
    await writeFile(join(source, "bundle.js"), "first");
    await writeFile(join(source, "image.png"), "image");
    const key = join(root, "signing/key.pem"),
      certificate = join(root, "signing/certificate.pem");
    execFileSync(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./mobile-ota.mjs", import.meta.url)),
        "keygen",
        "--dir",
        join(root, "signing"),
      ],
      { stdio: "ignore" },
    );
    NodeAssert.ok(
      new X509Certificate(await readFile(certificate)).keyUsage.includes("1.3.6.1.5.5.7.3.3"),
    );
    const fingerprintEnv = { ...process.env };
    delete fingerprintEnv.T3CODE_MOBILE_VERSION;
    const fingerprintConfig = NodeURL.fileURLToPath(
      new URL("../../apps/mobile/fingerprint.config.js", import.meta.url),
    );
    const readMajor = (env) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "-e",
            "console.log(JSON.stringify(require(process.argv[1]).extraSources))",
            fingerprintConfig,
          ],
          { cwd: root, env, encoding: "utf8" },
        ),
      )[0].contents;
    NodeAssert.equal(readMajor(fingerprintEnv), "2");
    NodeAssert.equal(readMajor({ ...fingerprintEnv, T3CODE_MOBILE_VERSION: "4.0.0" }), "4");
    const nativeConfig = JSON.parse(
      execFileSync(
        process.execPath,
        [
          NodeURL.fileURLToPath(
            new URL("../../apps/mobile/node_modules/expo/bin/cli", import.meta.url),
          ),
          "config",
          "--type",
          "public",
          "--json",
        ],
        {
          cwd: NodeURL.fileURLToPath(new URL("../../apps/mobile", import.meta.url)),
          env: {
            ...process.env,
            APP_VARIANT: "sidebar",
            T3_MOBILE_UPDATE_URL: "https://studio.example/api/mobile-updates/manifest",
            T3_MOBILE_UPDATE_CERTIFICATE: certificate,
            T3_MOBILE_ANDROID_PACKAGE: "com.example.delivery.fixture",
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ),
    );
    NodeAssert.deepEqual(nativeConfig.updates.requestHeaders, {
      "t3-update-selection": "latest",
      "t3-rollback-from": "none",
    });
    NodeAssert.deepEqual(nativeConfig.runtimeVersion, { policy: "fingerprint" });
    NodeAssert.equal(nativeConfig.android.package, "com.example.delivery.fixture");
    await writeFile(
      join(root, "expo-config.json"),
      JSON.stringify({ extra: { appVariant: "sidebar" } }),
    );
    const options = {
      config: join(root, "expo-config.json"),
      export: source,
      runtime: "native-a",
      platform: "android",
      origin: "https://studio.example",
      store,
      key,
      certificate,
    };
    const first = await publishMobileUpdate(options);
    await writeFile(join(source, "bundle.js"), "second");
    const second = await publishMobileUpdate(options);
    NodeAssert.notEqual(first.id, second.id);
    const catalog = JSON.parse(await readFile(join(store, "catalog.json"), "utf8"));
    NodeAssert.equal(catalog.releases.length, 2);
    for (const release of catalog.releases) {
      NodeAssert.ok(
        verify(
          "RSA-SHA256",
          Buffer.from(release.manifest),
          new X509Certificate(await readFile(certificate)).publicKey,
          Buffer.from(release.signature, "base64"),
        ),
      );
      const manifest = JSON.parse(release.manifest);
      NodeAssert.equal(manifest.runtimeVersion, "native-a");
      NodeAssert.equal(manifest.assets[0].key, "image.png");
      NodeAssert.ok(await readFile(join(store, "assets", manifest.launchAsset.hash)));
    }
    await NodeAssert.rejects(publishMobileUpdate({ ...options, runtime: "" }), /fingerprint/);
    const invalidCertificate = join(root, "invalid-certificate.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-key",
        key,
        "-subj",
        "/CN=Invalid OTA Test",
        "-days",
        "1",
        "-out",
        invalidCertificate,
      ],
      { stdio: "ignore" },
    );
    await NodeAssert.rejects(
      publishMobileUpdate({ ...options, certificate: invalidCertificate }),
      /Code Signing/,
    );
    const otherKey = join(root, "other-key.pem");
    execFileSync("openssl", ["genrsa", "-out", otherKey, "2048"], { stdio: "ignore" });
    await NodeAssert.rejects(publishMobileUpdate({ ...options, key: otherKey }), /does not match/);
    await writeFile(
      join(source, "metadata.json"),
      JSON.stringify({ fileMetadata: { android: { bundle: "../outside.js", assets: [] } } }),
    );
    await NodeAssert.rejects(publishMobileUpdate(options), /inside export/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
