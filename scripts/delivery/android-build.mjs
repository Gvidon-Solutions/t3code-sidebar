import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export function androidResources(
  env = process.env,
  threads = NodeOS.availableParallelism(),
  memory = NodeOS.totalmem(),
) {
  const workers = Number(
    env.T3_ANDROID_WORKERS ?? Math.max(1, Math.min(16, threads, Math.floor(memory / 2 ** 30 / 3))),
  );
  if (!Number.isInteger(workers) || workers < 1)
    throw new Error("T3_ANDROID_WORKERS must be a positive integer");
  const heap = Math.max(2, Math.min(12, Math.floor(memory / 2 ** 30 / 4)));
  return {
    workers,
    jvmargs: env.T3_ANDROID_JVMARGS ?? `-Xmx${heap}g -XX:MaxMetaspaceSize=2g -XX:+UseParallelGC`,
  };
}

export function androidArchitectures(value = "arm64-v8a") {
  const abis = value.split(",");
  if (
    new Set(abis).size !== abis.length ||
    abis.some((abi) => !["arm64-v8a", "armeabi-v7a", "x86", "x86_64"].includes(abi))
  ) {
    throw new Error("Invalid Android ABI list");
  }
  return abis.join(",");
}

export function needsAndroidPrebuild(directory, fingerprint, clean) {
  if (clean || !NodeFS.existsSync(NodePath.join(directory, "app/build.gradle"))) return true;
  const marker = NodePath.join(directory, ".t3-native-fingerprint");
  return !NodeFS.existsSync(marker) || NodeFS.readFileSync(marker, "utf8").trim() !== fingerprint;
}

export function updateAndroidVersion(file, version) {
  if (!version) return;
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Invalid Android version");
  const source = NodeFS.readFileSync(file, "utf8");
  const pattern = /\bversionName\s+(['"])[^'"\r\n]*\1/g;
  if ([...source.matchAll(pattern)].length !== 1)
    throw new Error("Expected exactly one Android versionName");
  const updated = source.replace(pattern, `versionName "${version}"`);
  if (source !== updated) NodeFS.writeFileSync(file, updated);
}

export function androidBuildKey(files, options) {
  const hash = NodeCrypto.createHash("sha256");
  hash.update(JSON.stringify(options));
  for (const file of files.toSorted((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path + "\0");
    hash.update(NodeCrypto.createHash("sha256").update(file.bytes).digest());
  }
  return hash.digest("hex");
}

export function configureAndroidGradle(file) {
  const source = NodeFS.readFileSync(file, "utf8");
  let updated = source.replace(
    /(\[[^\n]*\])\.execute\(null, rootDir\)\.text\.trim\(\)/g,
    "providers.exec { commandLine($1); workingDir(rootDir) }.standardOutput.asText.get().trim()",
  );
  if (!updated.includes("def t3ReactNativeDirectory =")) {
    updated = updated.replace(
      "react {",
      `def t3ReactNativeDirectory = file(providers.exec {
    commandLine("node", "--print", "require.resolve('react-native/package.json')")
    workingDir(rootDir)
}.standardOutput.asText.get().trim()).parentFile
rootProject.ext.REACT_NATIVE_NODE_MODULES_DIR = t3ReactNativeDirectory
project.ext.REACT_NATIVE_NODE_MODULES_DIR = t3ReactNativeDirectory

react {`,
    );
  }
  if (!updated.includes('hermesFlags = ["-O"]')) {
    updated = updated.replace("react {", 'react {\n    hermesFlags = ["-O"]');
  }
  const bundleInputPattern =
    /\n+def t3BundleInputs = files\([\s\S]*?\ntasks\.withType\(com\.facebook\.react\.tasks\.BundleHermesCTask\)\.configureEach \{\n\s*inputs\.files\(t3BundleInputs\)\.withPathSensitivity\(PathSensitivity\.RELATIVE\)\n\}\n?$/;
  updated = updated.replace(
    /\n+tasks\.matching \{ it\.name\.startsWith\("create"\) && it\.name\.endsWith\("UpdatesResources"\) \}\.configureEach \{[\s\S]*?\n\}\n?$/,
    "",
  );
  if (updated.includes("def t3BundleInputs") && !bundleInputPattern.test(updated))
    throw new Error("Unrecognized generated Android bundle input block; run --clean");
  updated = updated.replace(bundleInputPattern, "");
  updated += `

def t3BundleInputs = files(
    fileTree(projectRoot) {
        exclude "android/**", "ios/**", "node_modules/**", "build/**", "dist/**", ".expo/**", "profiles/**"
        exclude "modules/**/android/**", "modules/**/ios/**", "modules/**/cpp/**"
    },
    fileTree(new File(rootDir, "../../../packages")) {
        exclude "**/node_modules/**", "**/dist/**", "**/build/**", "**/.vite-plus/**"
    },
    fileTree(new File(rootDir, "../../../scripts/lib")),
    fileTree(new File(rootDir, "../../..")) { include ".env*", "tsconfig*.json", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml" }
)
tasks.withType(com.facebook.react.tasks.BundleHermesCTask).configureEach {
    inputs.files(t3BundleInputs).withPathSensitivity(PathSensitivity.RELATIVE)
}

tasks.matching { it.name.startsWith("create") && it.name.endsWith("UpdatesResources") }.configureEach {
    inputs.files(t3BundleInputs).withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.property("t3NativeFingerprint", providers.gradleProperty("t3AndroidNativeFingerprint"))
}
`;
  if (updated === source) return;
  NodeFS.writeFileSync(file, updated);
}
