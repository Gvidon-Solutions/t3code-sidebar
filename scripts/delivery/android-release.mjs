import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { androidEnvironment, androidArchitectures, androidBuildKey } from "./android-build.mjs";

const digest = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const exec = (command, args) =>
  NodeChildProcess.execFileSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

export function verifyReleaseApk(metadata, key, bytes) {
  return (
    metadata.schema === 1 &&
    metadata.key === key &&
    /^[A-Za-z0-9.+_-]+\.apk$/.test(metadata.file) &&
    metadata.sha256 === digest(bytes)
  );
}

function releaseKey() {
  const files = exec("git", [
    "ls-files",
    "-z",
    "--",
    "apps/mobile",
    "packages",
    "patches",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/lib",
    "tsconfig*.json",
    "package.json",
    "scripts/mobile-android-apk.mjs",
    "scripts/delivery/android-build.mjs",
    "scripts/delivery/android-release.mjs",
  ])
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ path, bytes: NodeFS.readFileSync(path) }));
  if (!process.env.T3_ANDROID_FINGERPRINT) throw new Error("Native fingerprint required");
  return androidBuildKey(files, {
    fingerprint: process.env.T3_ANDROID_FINGERPRINT,
    arch: androidArchitectures(process.env.ANDROID_ARCH),
    signing: digest(process.env.T3_ANDROID_KEYSTORE_BASE64 ?? ""),
    alias: process.env.T3_ANDROID_KEY_ALIAS ?? "t3-sidebar",
    environment: Object.entries(process.env)
      .filter(([key]) => /^(EXPO_PUBLIC_|T3_MOBILE_|T3CODE_MOBILE_|APP_VARIANT$)/.test(key))
      .sort(),
  });
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const [action, directory] = process.argv.slice(2);
  if (["bundle-environment", "update-environment"].includes(action)) {
    console.log(androidEnvironment(process.env, action === "update-environment"));
    process.exit(0);
  }
  if (!["restore", "record"].includes(action) || !directory)
    throw new Error("Usage: android-release.mjs restore|record OUTPUT_DIR");
  const key = releaseKey();
  NodeFS.mkdirSync(directory, { recursive: true });
  const descriptor = NodePath.join(directory, "android-build.json");
  if (action === "record") {
    const apks = NodeFS.readdirSync(directory).filter((file) => file.endsWith(".apk"));
    if (apks.length !== 1) throw new Error("Expected one release APK");
    NodeFS.writeFileSync(
      descriptor,
      JSON.stringify({
        schema: 1,
        key,
        file: apks[0],
        sha256: digest(NodeFS.readFileSync(NodePath.join(directory, apks[0]))),
      }),
    );
  } else {
    if (!process.env.GITHUB_REPOSITORY || !process.env.GITHUB_OUTPUT)
      throw new Error("GitHub repository/output required");
    const releases = JSON.parse(
      exec("gh", ["api", `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=20`]),
    );
    let reused = false;
    for (const release of releases.filter((release) => !release.draft)) {
      const asset = release.assets.find((asset) => asset.name === "android-build.json");
      if (!asset) continue;
      const metadata = JSON.parse(
        exec("gh", [
          "api",
          `repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${asset.id}`,
          "-H",
          "Accept: application/octet-stream",
        ]),
      );
      if (metadata.schema !== 1 || metadata.key !== key) continue;
      if (!/^[A-Za-z0-9.+_-]+\.apk$/.test(metadata.file))
        throw new Error("Unsafe release APK filename");
      exec("gh", [
        "release",
        "download",
        release.tag_name,
        "--repo",
        process.env.GITHUB_REPOSITORY,
        "--pattern",
        metadata.file,
        "--dir",
        directory,
      ]);
      if (
        !verifyReleaseApk(
          metadata,
          key,
          NodeFS.readFileSync(NodePath.join(directory, metadata.file)),
        )
      )
        throw new Error("Release APK digest mismatch");
      NodeFS.writeFileSync(descriptor, JSON.stringify(metadata));
      reused = true;
      break;
    }
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `reused=${reused}\n`);
  }
}
