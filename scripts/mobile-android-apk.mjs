#!/usr/bin/env node
import { applyAndroidSigningEnvironment } from "./lib/android-signing-env.mjs";
/**
 * Local Android APK build with a warm Gradle cache: keeps `apps/mobile/android`, builds one ABI and
 * skips R8 and PNG crunching for previews. Flags: --install (adb install -r), --dev (dev-client
 * APK), --clean (prebuild --clean).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  androidEnvironment,
  androidFingerprint,
  configureAndroidGradle,
  androidBuildKey,
  androidArchitectures,
  androidResources,
  needsAndroidPrebuild,
  updateAndroidVersion,
} from "./delivery/android-build.mjs";

const { spawnSync } = NodeChildProcess;
const { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } =
  NodeFS;
const { homedir } = NodeOS;
const { dirname, join, resolve } = NodePath;
const { fileURLToPath } = NodeURL;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(ROOT, "apps/mobile");
const ANDROID_DIR = join(APP_DIR, "android");
const OUTPUT_DIR = join(ROOT, "dist/mobile");
const args = new Set(process.argv.slice(2));
const install = args.has("--install");
const dev = args.has("--dev");
const clean = args.has("--clean");
const arch = androidArchitectures(process.env.T3_ANDROID_ARCH);
const resources = androidResources();
const timings = {};
const started = Date.now();
const sdkRoot =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  (existsSync(join(homedir(), "Android/Sdk")) ? join(homedir(), "Android/Sdk") : null);

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function run(command, commandArgs, cwd, extraEnv = {}) {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(" ")} exited with ${result.status ?? "no status"}`);
  }
  return Date.now() - started;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

if (!sdkRoot || !existsSync(sdkRoot)) {
  fail(
    "Android SDK not found. Set ANDROID_HOME (for example ~/Android/Sdk) or install the SDK first.",
  );
}
const java = spawnSync("java", ["-version"], { encoding: "utf8" });
if (java.status !== 0) {
  fail("java is not available. Install a JDK 17 or newer.");
}
const javaMajor = Number(java.stderr.match(/version "(\d+)/)?.[1] ?? "0");
if (javaMajor > 0 && javaMajor < 17) {
  fail(`Java ${javaMajor} is too old for this project; use JDK 17 or newer.`);
}

// A JRE satisfies `java -version` but not Gradle's JAVA_COMPILER toolchain.
// Prefer a real JDK; the system package on some machines is headless JRE only.
function isJdk(home) {
  return Boolean(home) && existsSync(join(home, "bin/javac"));
}
function siblingJdks(parent) {
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .map((entry) => join(parent, entry))
    .filter(isJdk);
}
const jdk =
  [
    process.env.JAVA_HOME,
    ...siblingJdks(join(homedir(), ".local/share")),
    ...siblingJdks(join(homedir(), ".gradle/jdks")),
  ].find(isJdk) ?? null;
if (!jdk) {
  fail("No JDK with javac found. Set JAVA_HOME to a JDK 17 or newer.");
}
process.env.JAVA_HOME = jdk;
process.env.PATH = `${join(jdk, "bin")}:${process.env.PATH ?? ""}`;

applyAndroidSigningEnvironment(process.env, dev);
const signingLabel =
  dev || !process.env.T3_ANDROID_KEYSTORE
    ? "debug keystore (uninstall a release build before installing this APK)"
    : "fork release keystore";

process.env.ANDROID_HOME = sdkRoot;
process.env.ANDROID_SDK_ROOT = sdkRoot;
process.env.EXPO_NO_GIT_STATUS = "1";
process.env.APP_VARIANT = dev ? "development" : "sidebar";
process.env.NODE_OPTIONS = process.env.NODE_OPTIONS ?? "--max-old-space-size=8192";

const fingerprintStart = Date.now();
const fingerprintResult = spawnSync(
  "pnpm",
  [
    "--silent",
    "exec",
    "expo-updates",
    dev ? "fingerprint:generate" : "runtimeversion:resolve",
    "--platform",
    "android",
  ],
  {
    cwd: APP_DIR,
    env: process.env,
    encoding: "utf8",
  },
);
if (fingerprintResult.status !== 0)
  fail(fingerprintResult.stderr || "Native fingerprint resolution failed");
const fingerprint = androidFingerprint(fingerprintResult.stdout, dev);
timings.fingerprintMs = Date.now() - fingerprintStart;
const filesResult = spawnSync(
  "git",
  [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "apps/mobile",
    "packages",
    "patches",
    "pnpm-lock.yaml",
    "package.json",
    "pnpm-workspace.yaml",
    "scripts/lib",
    "tsconfig*.json",
    "scripts/mobile-android-apk.mjs",
    "scripts/delivery/android-build.mjs",
  ],
  { cwd: ROOT, encoding: "utf8" },
);
if (filesResult.status !== 0) fail("Cannot enumerate Android build inputs");
const dotenvFiles = ["", "apps/mobile/"].flatMap((prefix) =>
  [".env", ".env.local", ".env.production", ".env.production.local"].map((file) => prefix + file),
);
const inputFiles = [...new Set([...filesResult.stdout.split("\0").filter(Boolean), ...dotenvFiles])]
  .filter((path) => existsSync(join(ROOT, path)))
  .map((path) => ({ path, bytes: readFileSync(join(ROOT, path)) }));
const buildKey = androidBuildKey(inputFiles, {
  fingerprint,
  arch,
  dev,
  node: process.version,
  alias: process.env.T3_ANDROID_KEY_ALIAS,
  version: process.env.T3_SIDEBAR_VERSION,
  environment: Object.entries(process.env)
    .filter(([key]) => /^(EXPO_PUBLIC_|T3_MOBILE_|T3CODE_MOBILE_|NODE_ENV$|APP_VARIANT$)/.test(key))
    .sort(),
  signing: process.env.T3_ANDROID_KEYSTORE
    ? readFileSync(process.env.T3_ANDROID_KEYSTORE).toString("base64")
    : "debug",
});
const outputPath = join(OUTPUT_DIR, dev ? "t3-sidebar-dev.apk" : "t3-sidebar.apk");
const buildMarker = outputPath + ".inputs";
if (
  !clean &&
  existsSync(outputPath) &&
  existsSync(buildMarker) &&
  readFileSync(buildMarker, "utf8") === buildKey
) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(
    join(OUTPUT_DIR, "android-timings.json"),
    JSON.stringify(
      { ...timings, totalMs: Date.now() - started, reused: true, arch, fingerprint },
      null,
      2,
    ),
  );
  console.log("Identical Android inputs; reusing " + outputPath);
  if (install) run("adb", ["install", "-r", outputPath], ROOT);
  process.exit(0);
}
const fingerprintMarker = join(ANDROID_DIR, ".t3-native-fingerprint");
timings.prebuildMs = 0;
if (needsAndroidPrebuild(ANDROID_DIR, fingerprint, clean)) {
  console.log("Native inputs changed; refreshing the Android project.");
  timings.prebuildMs = run(
    "pnpm",
    [
      "exec",
      "expo",
      "prebuild",
      "--platform",
      "android",
      "--no-install",
      ...(clean ? ["--clean"] : ["--no-clean"]),
    ],
    APP_DIR,
  );
  writeFileSync(fingerprintMarker, fingerprint + "\n");
}
configureAndroidGradle(join(ANDROID_DIR, "app/build.gradle"));
updateAndroidVersion(join(ANDROID_DIR, "app/build.gradle"), process.env.T3_SIDEBAR_VERSION);
const localProperties = join(ANDROID_DIR, "local.properties");
if (!existsSync(localProperties)) {
  writeFileSync(localProperties, `sdk.dir=${sdkRoot}\n`);
}

const gradleArgs = [
  dev ? "app:assembleDebug" : "app:assembleRelease",
  `-PreactNativeArchitectures=${arch}`,
  `-Pt3AndroidNativeFingerprint=${fingerprint}`,
  `-Pt3AndroidBundleEnvironment=${androidEnvironment()}`,
  `-Pt3AndroidUpdateEnvironment=${androidEnvironment(process.env, true)}`,
  "--build-cache",
  "--configuration-cache",
  "--daemon",
  "--profile",
  `-Dorg.gradle.jvmargs=${resources.jvmargs}`,
  "-Dorg.gradle.daemon.idletimeout=86400000",
  "--parallel",
  `--max-workers=${resources.workers}`,
  "--console=plain",
];
if (args.has("--info")) gradleArgs.push("--info");
if (!dev) {
  // Preview builds trade R8 and PNG crunching for time; the store build keeps both.
  gradleArgs.push("-Pandroid.enableMinifyInReleaseBuilds=false");
  gradleArgs.push("-Pandroid.enablePngCrunchInReleaseBuilds=false");
  // assembleRelease pulls in lintVitalRelease; it is a store gate, not a preview one.
  gradleArgs.push("-x", "lintVitalRelease");
}

console.log(
  `\nBuilding ${dev ? "dev-client" : "release"} APK for ${arch} from a ${clean ? "fresh" : "warm"} project.`,
);
console.log(`Signing: ${signingLabel}`);
const buildMs = run(join(ANDROID_DIR, "gradlew"), gradleArgs, ANDROID_DIR);

const apkPath = join(
  ANDROID_DIR,
  "app/build/outputs/apk",
  dev ? "debug/app-debug.apk" : "release/app-release.apk",
);
if (!existsSync(apkPath)) {
  fail(`Gradle finished but ${apkPath} was not produced.`);
}
mkdirSync(OUTPUT_DIR, { recursive: true });
copyFileSync(apkPath, outputPath);
writeFileSync(buildMarker, buildKey);
timings.gradleMs = buildMs;
timings.totalMs = Date.now() - started;
writeFileSync(
  join(OUTPUT_DIR, "android-timings.json"),
  JSON.stringify(
    { ...timings, arch, fingerprint, workers: resources.workers, jvmargs: resources.jvmargs },
    null,
    2,
  ),
);
const sizeMb = (statSync(outputPath).size / (1024 * 1024)).toFixed(1);

console.log(`\n✔ APK: ${outputPath} (${sizeMb} MB)`);
console.log(`  Gradle: ${formatDuration(buildMs)}`);
if (dev) {
  console.log("\nStart Metro for the dev client: pnpm --filter @t3tools/mobile dev:client");
} else {
  console.log("\nInstall it with: adb install -r " + outputPath);
}
if (install) {
  run("adb", ["install", "-r", outputPath], ROOT);
  console.log("✔ Installed on the connected Android device.");
}
