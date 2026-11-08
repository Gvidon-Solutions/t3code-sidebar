import { verifyMobileAssets } from "./target.mjs";
import * as NodeChildProcess from "node:child_process";
const { execFileSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { cpSync, copyFileSync, mkdirSync, readdirSync, renameSync, writeFileSync, existsSync } =
  NodeFS;
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
const { join, resolve } = NodePath;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export function changedArtifacts(paths) {
  paths = paths.filter(
    (path) =>
      !/\.(?:test|spec)\.[cm]?[jt]sx?$|\.node-test\.mjs$/.test(path) &&
      path !== "apps/desktop/scripts/delivery-ui-proof.mjs",
  );
  return {
    desktop: paths.some((path) =>
      /^(apps\/desktop\/|native\/|patches\/|pnpm-lock.yaml$)/.test(path),
    ),
    mobile: paths.some((path) =>
      /^(apps\/mobile\/|packages\/|patches\/|pnpm-lock.yaml$)/.test(path),
    ),
  };
}
export async function buildAssets({
  config,
  paths,
  logDir,
  version,
  previousFingerprint,
  arch,
  run,
}) {
  const changes = changedArtifacts(paths);
  const artifacts = [];
  if (changes.desktop) {
    await run("vp", ["run", "build:desktop"]);
    await run("vp", [
      "run",
      "dist:desktop:artifact",
      "--platform",
      "linux",
      "--target",
      "AppImage",
      "--arch",
      arch,
      "--build-version",
      version,
      "--skip-build",
    ]);
    artifacts.push(
      ...readdirSync(join(config.buildDir, "release"))
        .filter((file) => /\.(AppImage|deb)$|latest-linux\.yml$/.test(file))
        .map((file) => join(config.buildDir, "release", file)),
    );
  }
  let nativeFingerprint = previousFingerprint;
  let mobileUpdate = null;
  let apk = null;
  if (changes.mobile) {
    if (!config.ota)
      throw new Error(
        "Mobile delivery requires signing key, certificate and update origin in local ota config",
      );
    const mobileEnv = {
      ...config.ota.environment,
      APP_VARIANT: "sidebar",
      T3_MOBILE_UPDATE_URL: new URL("/api/mobile-updates/manifest", config.ota.origin).href,
      T3_MOBILE_UPDATE_CERTIFICATE: config.ota.certificate,
    };
    const exec = (command, args, options) =>
      execFileSync(command, args, {
        encoding: "utf8",
        timeout: 900_000,
        ...options,
        env: { ...process.env, ...mobileEnv },
      });
    const mobileDir = join(config.buildDir, "apps/mobile");
    const resolveFingerprint = () => {
      const fingerprint = JSON.parse(
        exec(
          "pnpm",
          ["--silent", "exec", "expo-updates", "runtimeversion:resolve", "--platform", "android"],
          { cwd: mobileDir },
        ),
      ).runtimeVersion;
      if (typeof fingerprint !== "string" || !fingerprint)
        throw new Error("Native fingerprint missing");
      return fingerprint;
    };
    let fingerprint = resolveFingerprint();
    if (fingerprint !== previousFingerprint) {
      await run(process.execPath, ["scripts/mobile-android-apk.mjs"], config.buildDir, mobileEnv);
      apk = join(config.buildDir, "dist/mobile/t3-sidebar.apk");
      artifacts.push(apk);
      fingerprint = resolveFingerprint();
    }
    nativeFingerprint = fingerprint;
    if (config.ota) {
      const output = join(logDir, "ota-export");
      const publicConfig = join(logDir, "expo-public.json");
      const candidate = join(logDir, "mobile-update-store");
      if (existsSync(config.ota.store)) cpSync(config.ota.store, candidate, { recursive: true });
      writeFileSync(
        publicConfig,
        exec("pnpm", ["--silent", "exec", "expo", "config", "--type", "public", "--json"], {
          cwd: mobileDir,
        }),
        { mode: 0o600 },
      );
      await run(
        "pnpm",
        ["exec", "expo", "export", "--platform", "android", "--output-dir", output],
        mobileDir,
        mobileEnv,
      );
      const existingApkUrl = existsSync(join(candidate, "catalog.json"))
        ? JSON.parse(NodeFS.readFileSync(join(candidate, "catalog.json"), "utf8")).apkAsset?.url
        : undefined;
      const apkUrl = existingApkUrl ?? config.ota.apkUrl;
      await run(process.execPath, [
        "scripts/delivery/mobile-ota.mjs",
        "publish",
        "--export",
        output,
        "--runtime",
        fingerprint,
        "--config",
        publicConfig,
        "--platform",
        "android",
        "--origin",
        config.ota.origin,
        "--store",
        candidate,
        "--key",
        config.ota.key,
        "--certificate",
        config.ota.certificate,
        ...(apkUrl ? ["--apk-url", apkUrl] : []),
      ]);
      if (apk) stageMobileApk(candidate, apk, config.ota.origin);
      mobileUpdate = { store: candidate };
    }
  }
  return { files: artifacts, nativeFingerprint, mobileUpdate };
}

function copyMobileStore(store, destination) {
  verifyMobileAssets(store);
  if (resolve(store) === resolve(destination)) return;
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  cpSync(join(store, "assets"), join(destination, "assets"), { recursive: true });
  verifyMobileAssets(destination);
  copyFileSync(join(store, "certificate.pem"), join(destination, "certificate.pem"));
  copyFileSync(join(store, "catalog.json"), join(destination, "catalog.json.tmp"));
  renameSync(join(destination, "catalog.json.tmp"), join(destination, "catalog.json"));
}

export async function publishMobileUpdate(store, config, machines) {
  const exec = (command, args, options = {}) =>
    execFileSync(command, args, { encoding: "utf8", timeout: 900_000, ...options });
  copyMobileStore(store, config.ota.store);
  for (const machine of machines) {
    const destination = join(machine.home, "mobile-updates");
    if (machine.ssh) {
      const staged = join(
        machine.uploadDir ?? machine.runtimeDir,
        `mobile-${NodeCrypto.randomUUID()}`,
      );
      exec("ssh", [
        "-o",
        "BatchMode=yes",
        ...(machine.sshArgs ?? []),
        machine.ssh,
        `mkdir -p ${quote(staged)}`,
      ]);
      exec("scp", [
        ...(machine.scpArgs ?? []),
        "-r",
        join(store, "assets"),
        `${machine.ssh}:${staged}/`,
      ]);
      exec("scp", [
        ...(machine.scpArgs ?? []),
        join(store, "certificate.pem"),
        `${machine.ssh}:${staged}/certificate.pem`,
      ]);
      exec("scp", [
        ...(machine.scpArgs ?? []),
        join(store, "catalog.json"),
        `${machine.ssh}:${staged}/catalog.json`,
      ]);
      exec(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          ...(machine.sshArgs ?? []),
          machine.ssh,
          `${quote(machine.node)} ${quote(join(machine.uploadDir ?? machine.runtimeDir, "delivery-target.mjs"))}`,
        ],
        {
          input: JSON.stringify({
            operation: "publishMobile",
            config: { ...machine, mobileStore: staged },
          }),
        },
      );
    } else copyMobileStore(store, destination);
  }
}

export function stageMobileApk(store, apk, origin) {
  const bytes = NodeFS.readFileSync(apk);
  const hash = NodeCrypto.createHash("sha256").update(bytes).digest("base64url");
  const url = new URL(`/api/mobile-updates/assets/${hash}`, origin).href;
  mkdirSync(join(store, "assets"), { recursive: true });
  copyFileSync(apk, join(store, "assets", hash));
  const catalogPath = join(store, "catalog.json");
  const catalog = JSON.parse(NodeFS.readFileSync(catalogPath, "utf8"));
  catalog.apkUrl = url;
  catalog.apkAsset = {
    key: hash,
    hash,
    url,
    contentType: "application/vnd.android.package-archive",
    fileExtension: "apk",
  };
  writeFileSync(catalogPath + ".tmp", JSON.stringify(catalog));
  renameSync(catalogPath + ".tmp", catalogPath);
}
