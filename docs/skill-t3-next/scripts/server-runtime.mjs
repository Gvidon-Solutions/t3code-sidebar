import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function detectServerUnit(unit, run = NodeChildProcess.spawnSync) {
  const candidates = [];
  for (const scope of ["user", "system"]) {
    const prefix = scope === "user" ? ["--user"] : [];
    const result = run("systemctl", [...prefix, "cat", unit], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error && result.error.code !== "ENOENT") throw result.error;
    if (result.status !== 0) continue;
    const active =
      run("systemctl", [...prefix, "is-active", unit], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).status === 0;
    candidates.push({ scope, prefix, unit, text: result.stdout, active });
  }
  return candidates.find((candidate) => candidate.active) ?? candidates[0] ?? null;
}

export function releaseRuntimeAsset(release) {
  return release?.assets?.find((asset) => /^t3-(.+)-linux-x64\.tar\.gz$/.test(asset.name));
}

function installArchive(home, version, archive) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(version)) throw new Error("Invalid runtime version");
  const versions = NodePath.join(home, "runtime", "versions");
  NodeFS.mkdirSync(versions, { recursive: true });
  const destination = NodePath.join(versions, version);
  if (NodeFS.existsSync(NodePath.join(destination, "t3")))
    return { version, path: destination, existing: true };
  const staging = NodeFS.mkdtempSync(NodePath.join(versions, ".install-"));
  try {
    const file = NodePath.join(staging, "runtime.tar.gz");
    NodeFS.writeFileSync(file, archive);
    const contents = NodeChildProcess.execFileSync("tar", ["-tzf", file], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (contents.split("\n").some((path) => path.startsWith("/") || path.split("/").includes("..")))
      throw new Error("Unsafe runtime archive");
    const extracted = NodePath.join(staging, "extracted");
    NodeFS.mkdirSync(extracted);
    NodeChildProcess.execFileSync("tar", ["-xzf", file, "-C", extracted, "--strip-components=1"]);
    if (!NodeFS.existsSync(NodePath.join(extracted, "t3")))
      throw new Error("Runtime archive contains no t3 executable");
    NodeFS.renameSync(extracted, destination);
    return { version, path: destination, existing: false };
  } finally {
    NodeFS.rmSync(staging, { recursive: true, force: true });
  }
}

export async function installPublicRuntime({
  home,
  repository,
  want,
  fetcher = fetch,
  api = "https://api.github.com",
}) {
  const root = `${api.replace(/\/$/, "")}/repos/${repository}/releases`;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "t3ctl" };
  let release;
  if (want === "latest" || want.includes("-sidebar.")) {
    const response = await fetcher(
      want === "latest" ? `${root}/latest` : `${root}/tags/sidebar-v${encodeURIComponent(want)}`,
      { headers },
    );
    if (!response.ok) throw new Error(`Public release lookup returned HTTP ${response.status}`);
    release = await response.json();
  } else {
    for (let page = 1; ; page++) {
      const response = await fetcher(`${root}?per_page=100&page=${page}`, { headers });
      if (!response.ok) throw new Error(`Public release lookup returned HTTP ${response.status}`);
      const releases = await response.json();
      if (!Array.isArray(releases)) throw new Error("Invalid public release list");
      release = releases.find((item) =>
        item.tag_name?.endsWith(`-sidebar.${want.replace(/^sidebar\./, "")}`),
      );
      if (release || releases.length < 100) break;
    }
  }
  const asset = releaseRuntimeAsset(release);
  if (!asset)
    throw new Error(
      "This public release has no Linux CLI archive; copy its runtime from a linked machine",
    );
  const response = await fetcher(asset.browser_download_url, {
    headers: { "User-Agent": "t3ctl" },
  });
  if (!response.ok) throw new Error(`Public runtime download returned HTTP ${response.status}`);
  const version = /^t3-(.+)-linux-x64\.tar\.gz$/.exec(asset.name)[1];
  return installArchive(home, version, new Uint8Array(await response.arrayBuffer()));
}

const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";

export function installSshRuntime({
  home,
  want,
  destination,
  identityFile,
  remoteHome,
  run = NodeChildProcess.execFileSync,
}) {
  const port = /^(.*):(\d+)$/.exec(destination);
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    ...(identityFile ? ["-i", identityFile, "-o", "IdentitiesOnly=yes"] : []),
    ...(port ? ["-p", port[2]] : []),
    "--",
    port ? port[1] : destination,
  ];
  const script = `const fs=require('node:fs'),p=require('node:path'),o=require('node:os');const root=p.join(process.argv[1]||process.env.T3CODE_HOME||p.join(o.homedir(),'.t3-sidebar-server'),'runtime','versions');const rows=fs.readdirSync(root).filter(v=>/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(v)&&fs.existsSync(p.join(root,v,'t3')));process.stdout.write(JSON.stringify({root,versions:rows}));`;
  const listing = JSON.parse(
    run("ssh", [...args, ["node", "-e", script, "--", remoteHome ?? ""].map(quote).join(" ")], {
      encoding: "utf8",
      timeout: 30000,
    }),
  );
  const matching = listing.versions.filter(
    (v) =>
      want === "latest" || v === want || v.endsWith(`-sidebar.${want.replace(/^sidebar\./, "")}`),
  );
  matching.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const version = matching.at(-1);
  if (!version) throw new Error("The linked machine does not have that runtime installed");
  const archive = run(
    "ssh",
    [...args, `tar -czf - -C ${quote(listing.root)} -- ${quote(version)}`],
    { maxBuffer: 512 * 1024 * 1024, timeout: 180000 },
  );
  return installArchive(home, version, archive);
}
