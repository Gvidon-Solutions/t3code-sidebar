import * as NodeFS from "node:fs";
const fs = NodeFS;
import * as NodeOS from "node:os";
const os = NodeOS;
import * as NodePath from "node:path";
const path = NodePath;
import * as NodeChildProcess from "node:child_process";
const cp = NodeChildProcess;
import * as NodeURL from "node:url";
const url = NodeURL;

export function render(machine, machines, body) {
  const neighbors = machines
    .filter((m) => m.id !== machine.id)
    .map((m) => `${m.label} (${m.tag})`)
    .join(", ");
  return `> Эта машина — **${machine.label}** (${machine.tag}): ${machine.role}; соседние: ${neighbors}.\n\n${body}`;
}

export function unifiedDiff(before, after, name) {
  if (before === after) return "";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agents-diff-"));
  try {
    fs.writeFileSync(path.join(dir, "before"), before);
    fs.writeFileSync(path.join(dir, "after"), after);
    const result = cp.spawnSync(
      "diff",
      [
        "-u",
        "--label",
        `${name} (old)`,
        "--label",
        `${name} (rendered)`,
        path.join(dir, "before"),
        path.join(dir, "after"),
      ],
      { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 1 && result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Executed in the target HOME, locally or through SSH; stdin carries only JSON.
export function targetOperation(input) {
  const { operation, files, content, stamp } = input;
  const home = input.home ?? os.homedir();
  return files.map((file) => {
    if (![".claude/CLAUDE.md", ".codex/AGENTS.md", ".config/opencode/AGENTS.md"].includes(file))
      throw new Error(`Invalid harness file: ${file}`);
    const dest = path.join(home, file);
    const present = fs.existsSync(path.dirname(dest));
    if (!present) return { file, state: "harness absent" };
    const exists = fs.existsSync(dest);
    const before = exists ? fs.readFileSync(dest, "utf8") : "";
    const state = exists ? (before === content ? "in sync" : "differs") : "missing";
    let backup;
    if (operation === "apply" && state !== "in sync") {
      const root = path.join(home, ".local/state/t3-agents-sync", stamp);
      backup = path.join(root, file);
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
      if (exists) fs.copyFileSync(dest, backup, fs.constants.COPYFILE_EXCL);
      else
        fs.writeFileSync(`${backup}.missing`, "File did not exist\n", { flag: "wx", mode: 0o600 });
      const temp = `${dest}.t3-agents-${stamp}`;
      fs.writeFileSync(temp, content, {
        flag: "wx",
        mode: exists ? fs.statSync(dest).mode & 0o777 : 0o600,
      });
      fs.renameSync(temp, dest);
      if (fs.readFileSync(dest, "utf8") !== content)
        throw new Error(`Verification failed: ${dest}`);
    }
    return { file, state, before, backup, verified: operation === "apply" };
  });
}

export const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export function sshTransport(machines, source, target, command, visited = [], remote = false) {
  const hop = `${source}->${target.id}`;
  if (visited.includes(hop)) throw new Error("Cyclic SSH route: " + [...visited, hop].join(" -> "));
  const via = target.via?.[source];
  if (via) {
    if (via === target.id) throw new Error("Cyclic SSH route: " + hop);
    const relay = machines.find((machine) => machine.id === via);
    if (!relay) throw new Error("Unknown relay " + via);
    const inner = sshTransport(machines, via, target, command, [...visited, hop], true);
    const nested = ["ssh", ...inner]
      .map((value) =>
        value.startsWith("~/") ? '"$HOME"/' + shellQuote(value.slice(2)) : shellQuote(value),
      )
      .join(" ");
    return sshTransport(machines, source, relay, nested, [...visited, hop], remote);
  }
  const destination = target.ssh?.[source];
  if (!destination) throw new Error(`No SSH route from ${source} to ${target.id}`);
  const options = (target.sshOptions?.[source] ?? []).map((value) =>
    remote ? value : value.replace(/^~\//, os.homedir() + "/"),
  );
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...options, destination, command];
}

export function runAgents(pos, opt) {
  const operation = pos[0];
  if (!["sync", "status"].includes(operation))
    throw new Error(
      "Usage: t3ctl agents sync [--to all|machine,…] [--home /isolated/home] [--apply] | status [--to …] [--home /isolated/home]",
    );
  const root =
    opt.config ||
    process.env.T3CTL_AGENTS_CONFIG ||
    url.fileURLToPath(new URL("../global/", import.meta.url));
  const machines = JSON.parse(fs.readFileSync(path.join(root, "machines.json"), "utf8"));
  const body = fs.readFileSync(path.join(root, "GLOBAL.md"), "utf8");
  const source = os.hostname().split(".")[0].toLowerCase();
  if (!machines.some((m) => m.id === source)) throw new Error(`Unknown source machine ${source}`);
  const ids = String(opt.to || (opt.home ? source : "all"))
    .toLowerCase()
    .split(",");
  const selected = ids.includes("all")
    ? machines
    : ids.map((id) => {
        const machine = machines.find((m) => m.id === id);
        if (!machine) throw new Error(`Unknown machine ${id}`);
        return machine;
      });
  if (
    opt.home &&
    (!path.isAbsolute(opt.home) || selected.length !== 1 || selected[0].id !== source)
  )
    throw new Error("--home requires an absolute path and only the local machine target");
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const remoteScript = `import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path'; const targetOperation = ${targetOperation.toString()}; try { console.log(JSON.stringify(targetOperation(JSON.parse(fs.readFileSync(0,'utf8'))))); } catch(e) { console.error(e.stack); process.exitCode=1; }`;
  for (const machine of selected) {
    const content = render(machine, machines, body);
    const input = {
      operation: operation === "sync" && opt.apply ? "apply" : "read",
      files: machine.harnessFiles,
      content,
      stamp,
      ...(opt.home ? { home: opt.home } : {}),
    };
    let rows;
    if (source === machine.id) rows = targetOperation(input);
    else {
      const command = `${machine.nodeCommand || "node"} --input-type=module -e ${shellQuote(remoteScript)}`;
      const result = cp.spawnSync("ssh", sshTransport(machines, source, machine, command), {
        input: JSON.stringify(input),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${machine.id}: ${result.stderr}`);
      rows = JSON.parse(result.stdout);
    }
    for (const row of rows) {
      console.log(
        `${machine.id} ~/${row.file}: ${row.verified ? "in sync (verified)" : row.state}${row.backup ? `; backup ${row.backup}` : ""}`,
      );
      if (operation === "sync" && !opt.apply && row.before !== undefined)
        process.stdout.write(unifiedDiff(row.before, content, `${machine.id}:~/${row.file}`));
    }
  }
}
