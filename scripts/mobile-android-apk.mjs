#!/usr/bin/env node
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
const arch = process.env.T3_ANDROID_ARCH ?? "arm64-v8a";
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

// Match the GitHub release APK's signing identity when the fork keystore is
// available, so `adb install -r` updates an installed sidebar build instead of
// failing with a signature mismatch. Never print the values.
const signingEnvPath = join(homedir(), ".local/share/t3-ws/android-signing.env");
if (!dev && !process.env.T3_ANDROID_KEYSTORE && existsSync(signingEnvPath)) {
  for (const line of readFileSync(signingEnvPath, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?(T3_ANDROID_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}
const signingLabel =
  dev || !process.env.T3_ANDROID_KEYSTORE
    ? "debug keystore (uninstall a release build before installing this APK)"
    : "fork release keystore";

process.env.ANDROID_HOME = sdkRoot;
process.env.ANDROID_SDK_ROOT = sdkRoot;
process.env.EXPO_NO_GIT_STATUS = "1";
process.env.APP_VARIANT = dev ? "development" : "sidebar";
process.env.NODE_OPTIONS = process.env.NODE_OPTIONS ?? "--max-old-space-size=8192";

const generatedMarker = join(ANDROID_DIR, "app/build.gradle");
const nativeInputs = [
  join(APP_DIR, "app.config.ts"),
  join(APP_DIR, "app.json"),
  join(ROOT, "pnpm-lock.yaml"),
];
const nativeInputsNewer =
  existsSync(generatedMarker) &&
  nativeInputs.some(
    (input) => existsSync(input) && statSync(input).mtimeMs > statSync(generatedMarker).mtimeMs,
  );
const variantMarker = join(ANDROID_DIR, ".t3-variant");
const variantChanged =
  !existsSync(variantMarker) ||
  readFileSync(variantMarker, "utf8").trim() !== process.env.APP_VARIANT;

if (!existsSync(ANDROID_DIR) || clean || nativeInputsNewer || variantChanged) {
  const cleanPrebuild = clean || (variantChanged && existsSync(ANDROID_DIR));
  console.log(
    cleanPrebuild
      ? "Prebuilding a clean Android project (this is the slow path; native config or app variant changed)."
      : existsSync(ANDROID_DIR)
        ? "Native config changed since the last prebuild; refreshing the Android project."
        : "Prebuilding the Android project for the first time.",
  );
  run(
    "pnpm",
    [
      "exec",
      "expo",
      "prebuild",
      "--platform",
      "android",
      "--no-install",
      ...(cleanPrebuild ? ["--clean"] : []),
    ],
    APP_DIR,
  );
  writeFileSync(variantMarker, `${process.env.APP_VARIANT}\n`);
}
const localProperties = join(ANDROID_DIR, "local.properties");
if (!existsSync(localProperties)) {
  writeFileSync(localProperties, `sdk.dir=${sdkRoot}\n`);
}

const gradleArgs = [
  dev ? "app:assembleDebug" : "app:assembleRelease",
  `-PreactNativeArchitectures=${arch}`,
  "--build-cache",
  "--parallel",
  `--max-workers=${process.env.T3_ANDROID_WORKERS ?? "8"}`,
  "--console=plain",
];
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
const outputPath = join(OUTPUT_DIR, dev ? "t3-sidebar-dev.apk" : "t3-sidebar.apk");
copyFileSync(apkPath, outputPath);
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
