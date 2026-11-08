import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeFS from "node:fs";
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = NodeFS;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;
import {
  configureAndroidGradle,
  androidBuildKey,
  androidResources,
  androidArchitectures,
  needsAndroidPrebuild,
  updateAndroidVersion,
} from "./android-build.mjs";

test("native fingerprint invalidates generated config while identical inputs preserve the native tree", () => {
  const root = mkdtempSync(join(tmpdir(), "android-build-"));
  try {
    assert.equal(needsAndroidPrebuild(root, "native-a", false), true);
    mkdirSync(join(root, "app"));
    const gradle = join(root, "app/build.gradle");
    writeFileSync(gradle, 'versionName "old"\nversionCode 1\napplicationId "com.example.app"');
    assert.equal(needsAndroidPrebuild(root, "native-a", false), true);
    writeFileSync(join(root, ".t3-native-fingerprint"), "native-a\n");
    assert.equal(needsAndroidPrebuild(root, "native-a", false), false);
    assert.equal(needsAndroidPrebuild(root, "native-b", false), true);
    assert.equal(needsAndroidPrebuild(root, "native-a", true), true);
    updateAndroidVersion(gradle, "0.1.7-sidebar.63");
    assert.equal(
      readFileSync(gradle, "utf8"),
      'versionName "0.1.7-sidebar.63"\nversionCode 1\napplicationId "com.example.app"',
    );
    assert.throws(() => updateAndroidVersion(gradle, 'bad"version'), /Invalid/);
    writeFileSync(gradle, "versionCode 1");
    assert.throws(() => updateAndroidVersion(gradle, "1"), /exactly one/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resources respect small builders and explicit overrides; ABI selection does not expand release coverage", () => {
  assert.equal(androidResources({}, 128, 125 * 2 ** 30).workers, 16);
  assert.equal(androidResources({}, 2, 7 * 2 ** 30).workers, 2);
  assert.equal(
    androidResources({ T3_ANDROID_WORKERS: "4", T3_ANDROID_JVMARGS: "-Xmx3g" }).jvmargs,
    "-Xmx3g",
  );
  assert.throws(() => androidResources({ T3_ANDROID_WORKERS: "0" }), /positive integer/);
  assert.equal(androidArchitectures(), "arm64-v8a");
  assert.equal(androidArchitectures("arm64-v8a,x86_64"), "arm64-v8a,x86_64");
  for (const value of ["", "arm", "arm64-v8a,arm64-v8a"])
    assert.throws(() => androidArchitectures(value), /ABI/);
});

test("APK reuse invalidates on JS, native, ABI, signing and environment inputs", () => {
  const files = [{ path: "app/index.ts", bytes: Buffer.from("first") }];
  const options = {
    fingerprint: "native-a",
    arch: "arm64-v8a",
    signing: "release",
    environment: [],
  };
  const key = androidBuildKey(files, options);
  assert.equal(androidBuildKey([...files], { ...options }), key);
  assert.notEqual(androidBuildKey([{ ...files[0], bytes: Buffer.from("second") }], options), key);
  for (const change of [
    { fingerprint: "native-b" },
    { arch: "x86_64" },
    { signing: "other" },
    { environment: [["EXPO_PUBLIC_HOST", "changed"]] },
  ])
    assert.notEqual(androidBuildKey(files, { ...options, ...change }), key);
});

test("generated Gradle resolves Node inputs through providers and supplies both native-library directory hints", () => {
  const root = mkdtempSync(join(tmpdir(), "android-gradle-"));
  try {
    const file = join(root, "build.gradle");
    writeFileSync(
      file,
      'react {\n reactNativeDir = new File(["node", "--print", "require.resolve(\'react-native/package.json\')"].execute(null, rootDir).text.trim()).getParentFile()\n}',
    );
    configureAndroidGradle(file);
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(".execute(null, rootDir)"));
    assert.ok(text.includes("providers.exec { commandLine("));
    assert.ok(
      text.includes(
        'inputs.property("t3NativeFingerprint", providers.gradleProperty("t3AndroidNativeFingerprint"))',
      ),
    );
    assert.ok(text.includes("rootProject.ext.REACT_NATIVE_NODE_MODULES_DIR"));
    assert.ok(text.includes("project.ext.REACT_NATIVE_NODE_MODULES_DIR"));
    configureAndroidGradle(file);
    assert.equal(readFileSync(file, "utf8"), text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release reuse requires the exact source key and APK digest and rejects path traversal", async () => {
  const { verifyReleaseApk } = await import("./android-release.mjs");
  const bytes = Buffer.from("signed-apk");
  const metadata = {
    schema: 1,
    key: "inputs",
    file: "App-1.apk",
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  };
  assert.equal(verifyReleaseApk(metadata, "inputs", bytes), true);
  assert.equal(verifyReleaseApk(metadata, "changed", bytes), false);
  assert.equal(verifyReleaseApk(metadata, "inputs", Buffer.from("tampered")), false);
  assert.equal(verifyReleaseApk({ ...metadata, file: "../App.apk" }, "inputs", bytes), false);
});

test("release CLI records inputs, restores the matching release and rejects a corrupted download", () => {
  const root = mkdtempSync(join(tmpdir(), "android-release-"));
  const exec = (command, args, options = {}) =>
    NodeChildProcess.execFileSync(command, args, { cwd: root, stdio: "pipe", ...options });
  try {
    mkdirSync(join(root, "apps/mobile"), { recursive: true });
    writeFileSync(join(root, "apps/mobile/index.ts"), "export const marker = 1;");
    exec("git", ["init", "-q"]);
    exec("git", ["add", "apps"]);
    const release = join(root, "release"),
      bin = join(root, "bin"),
      output = join(root, "restored");
    mkdirSync(release);
    mkdirSync(bin);
    writeFileSync(join(release, "App.apk"), "signed-apk");
    const script = NodeURL.fileURLToPath(new URL("./android-release.mjs", import.meta.url));
    const env = {
      ...process.env,
      PATH: bin + NodePath.delimiter + process.env.PATH,
      T3_ANDROID_FINGERPRINT: "native-a",
      GITHUB_REPOSITORY: "example/app",
      GITHUB_OUTPUT: join(root, "outputs"),
      ANDROID_RELEASE_FIXTURE: release,
    };
    exec(process.execPath, [script, "record", release], { env });
    writeFileSync(
      join(bin, "gh"),
      '#!/usr/bin/env node\nconst fs=require("node:fs"),p=require("node:path"),args=process.argv.slice(2),root=process.env.ANDROID_RELEASE_FIXTURE;if(args[0]==="api"){process.stdout.write(args[1].includes("releases?")?JSON.stringify([{tag_name:"v1",draft:false,assets:[{name:"android-build.json",id:1}]}]):fs.readFileSync(p.join(root,"android-build.json")));}else{fs.copyFileSync(p.join(root,"App.apk"),p.join(args[args.indexOf("--dir")+1],"App.apk"));}',
    );
    NodeFS.chmodSync(join(bin, "gh"), 0o755);
    exec(process.execPath, [script, "restore", output], { env });
    assert.equal(readFileSync(join(output, "App.apk"), "utf8"), "signed-apk");
    assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "reused=true\n");
    writeFileSync(join(release, "App.apk"), "tampered");
    assert.throws(
      () => exec(process.execPath, [script, "restore", join(root, "corrupt")], { env }),
      /digest mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
