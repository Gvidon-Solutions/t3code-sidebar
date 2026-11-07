import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
const { createHash, randomUUID, sign, verify, X509Certificate } = NodeCrypto;
const { readFile, writeFile, mkdir, rename, stat } = NodeFSP;
const { resolve, join, sep, basename } = NodePath;
const { spawnSync } = NodeChildProcess;
const { parseArgs } = NodeUtil;
const { pathToFileURL } = NodeURL;

export async function publishMobileUpdate(options) {
  const { export: exportDir, runtime, platform, origin, store, key, certificate } = options;
  if (!runtime || !["android", "ios"].includes(platform))
    throw new Error("Native runtime fingerprint and platform required");
  const base = new URL(origin);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname))
    throw new Error("OTA origin requires HTTPS");
  const metadata = JSON.parse(await readFile(join(exportDir, "metadata.json"), "utf8"));
  const files = metadata.fileMetadata?.[platform];
  if (!files?.bundle || !Array.isArray(files.assets))
    throw new Error("Expo export metadata missing platform bundle/assets");
  await mkdir(join(store, "assets"), { recursive: true });
  const asset = async (relativePath, ext) => {
    const file = resolve(exportDir, relativePath);
    if (!file.startsWith(resolve(exportDir) + sep) || !(await stat(file)).isFile())
      throw new Error("Export asset must be inside export directory");
    const bytes = await readFile(file);
    const hash = createHash("sha256").update(bytes).digest("base64url");
    try {
      await writeFile(join(store, "assets", hash), bytes, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readFile(join(store, "assets", hash));
      if (createHash("sha256").update(existing).digest("base64url") !== hash)
        throw new Error("Existing OTA asset is corrupt", { cause: error });
    }
    return {
      key: basename(relativePath),
      hash,
      fileExtension: "." + ext,
      contentType:
        ext === "js" || ext === "hbc"
          ? "application/javascript"
          : ({
              png: "image/png",
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              webp: "image/webp",
              gif: "image/gif",
              ttf: "font/ttf",
              otf: "font/otf",
              woff: "font/woff",
              woff2: "font/woff2",
              json: "application/json",
              mp3: "audio/mpeg",
              mp4: "video/mp4",
            }[ext] ?? "application/octet-stream"),
      url: new URL("/api/mobile-updates/assets/" + hash, base).href,
    };
  };
  if (!options.config) throw new Error("--config with Expo public config JSON is required");
  const publicConfig = JSON.parse(await readFile(options.config, "utf8"));
  delete publicConfig._internal;
  if (publicConfig.updates) delete publicConfig.updates.codeSigningCertificate;
  const id = randomUUID();
  const manifest = JSON.stringify({
    id,
    createdAt: new Date().toISOString(),
    runtimeVersion: runtime,
    launchAsset: await asset(files.bundle, "js"),
    assets: await Promise.all(files.assets.map(({ path, ext }) => asset(path, ext))),
    metadata: { bundle: id },
    extra: { expoClient: publicConfig },
  });
  const signature = sign("RSA-SHA256", Buffer.from(manifest), await readFile(key)).toString(
    "base64",
  );
  const cert = await readFile(certificate, "utf8");
  if (
    !verify(
      "RSA-SHA256",
      Buffer.from(manifest),
      new X509Certificate(cert).publicKey,
      Buffer.from(signature, "base64"),
    )
  )
    throw new Error("Signing key does not match the native certificate");
  const catalogPath = join(store, "catalog.json");
  let catalog = { releases: [] };
  try {
    catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!Array.isArray(catalog.releases)) throw new Error("Invalid OTA catalog");
  const existingCertificate = await readFile(join(store, "certificate.pem"), "utf8").catch(
    (error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    },
  );
  if (existingCertificate && existingCertificate !== cert)
    throw new Error("Certificate rotation requires a separate store and native app rebuild");
  if (!existingCertificate) await writeFile(join(store, "certificate.pem"), cert, { flag: "wx" });
  catalog.releases.push({ manifest, signature, platform });
  if (options["apk-url"]) catalog.apkUrl = new URL(options["apk-url"]).href;
  await writeFile(catalogPath + ".tmp", JSON.stringify(catalog));
  await rename(catalogPath + ".tmp", catalogPath);
  return { id, runtimeVersion: runtime, assets: files.assets.length + 1 };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      [
        "export",
        "runtime",
        "platform",
        "origin",
        "store",
        "key",
        "certificate",
        "config",
        "apk-url",
        "dir",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  if (positionals[0] === "keygen") {
    if (!values.dir) throw new Error("--dir required");
    await mkdir(values.dir, { recursive: true, mode: 0o700 });
    for (const name of ["key.pem", "certificate.pem"]) {
      try {
        await stat(join(values.dir, name));
        throw new Error("Signing material exists; refusing overwrite");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const result = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-days",
        "3650",
        "-subj",
        "/CN=T3 Mobile Updates",
        "-keyout",
        join(values.dir, "key.pem"),
        "-out",
        join(values.dir, "certificate.pem"),
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("OpenSSL key generation failed");
    return;
  }
  if (positionals[0] !== "publish") throw new Error("Expected keygen or publish");
  console.log(JSON.stringify(await publishMobileUpdate(values)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
