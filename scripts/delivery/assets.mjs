import * as NodeChildProcess from "node:child_process";
const { execFileSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { cpSync, copyFileSync, mkdirSync, readdirSync, renameSync, writeFileSync } = NodeFS;
import * as NodePath from "node:path";
const { join, resolve } = NodePath;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export function changedArtifacts(paths) {
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
  machines,
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
    const fingerprint = JSON.parse(
      exec("pnpm", ["exec", "expo-updates", "runtimeversion:resolve", "--platform", "android"], {
        cwd: mobileDir,
      }),
    ).runtimeVersion;
    if (typeof fingerprint !== "string" || !fingerprint)
      throw new Error("Native fingerprint missing");
    nativeFingerprint = fingerprint;
    if (fingerprint !== previousFingerprint) {
      await run(process.execPath, ["scripts/mobile-android-apk.mjs"], config.buildDir, mobileEnv);
      artifacts.push(
        ...readdirSync(join(config.buildDir, "dist/mobile"))
          .filter((file) => file.endsWith(".apk"))
          .map((file) => join(config.buildDir, "dist/mobile", file)),
      );
    }
    if (config.ota) {
      const output = join(logDir, "ota-export");
      const publicConfig = join(logDir, "expo-public.json");
      writeFileSync(
        publicConfig,
        exec("pnpm", ["exec", "expo", "config", "--type", "public", "--json"], { cwd: mobileDir }),
        { mode: 0o600 },
      );
      await run(
        "pnpm",
        ["exec", "expo", "export", "--platform", "android", "--output-dir", output],
        mobileDir,
        mobileEnv,
      );
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
        config.ota.store,
        "--key",
        config.ota.key,
        "--certificate",
        config.ota.certificate,
        ...(config.ota.apkUrl ? ["--apk-url", config.ota.apkUrl] : []),
      ]);
      for (const machine of machines) {
        const destination = join(machine.home, "mobile-updates");
        if (machine.ssh) {
          exec("ssh", [
            "-o",
            "BatchMode=yes",
            ...(machine.sshArgs ?? []),
            machine.ssh,
            `mkdir -p ${quote(destination)}`,
          ]);
          exec("scp", [
            ...(machine.scpArgs ?? []),
            "-r",
            join(config.ota.store, "assets"),
            `${machine.ssh}:${destination}/`,
          ]);
          exec("scp", [
            ...(machine.scpArgs ?? []),
            join(config.ota.store, "certificate.pem"),
            `${machine.ssh}:${destination}/certificate.pem`,
          ]);
          exec("scp", [
            ...(machine.scpArgs ?? []),
            join(config.ota.store, "catalog.json"),
            `${machine.ssh}:${destination}/catalog.json.tmp`,
          ]);
          exec("ssh", [
            "-o",
            "BatchMode=yes",
            ...(machine.sshArgs ?? []),
            machine.ssh,
            `mv ${quote(join(destination, "catalog.json.tmp"))} ${quote(join(destination, "catalog.json"))}`,
          ]);
        } else if (resolve(config.ota.store) !== resolve(destination)) {
          mkdirSync(destination, { recursive: true, mode: 0o700 });
          cpSync(join(config.ota.store, "assets"), join(destination, "assets"), {
            recursive: true,
          });
          copyFileSync(
            join(config.ota.store, "certificate.pem"),
            join(destination, "certificate.pem"),
          );
          copyFileSync(
            join(config.ota.store, "catalog.json"),
            join(destination, "catalog.json.tmp"),
          );
          renameSync(join(destination, "catalog.json.tmp"), join(destination, "catalog.json"));
        }
      }
    }
  }
  return { files: artifacts, nativeFingerprint };
}
