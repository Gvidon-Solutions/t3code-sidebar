import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { readFileSync, mkdtempSync, rmSync, mkdirSync } = NodeFS;
import * as NodeOS from "node:os";
const { hostname, homedir, tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join, resolve } = NodePath;
import * as NodeURL from "node:url";
const { fileURLToPath } = NodeURL;
import { sshTransport, shellQuote, runAgents } from "./skills/t3/scripts/agents-sync.mjs";

const root = fileURLToPath(new URL("./", import.meta.url));
const skill = join(root, "skills/t3");
const config = process.env.T3CTL_AGENTS_CONFIG || join(skill, "global");
const args = process.argv.slice(2);
const option = (key) => {
  const i = args.indexOf(key);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${key} needs a value`);
  return args[i + 1];
};
const run = (command, argv) => {
  const result = spawnSync(command, argv, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
};
const machines = () => JSON.parse(readFileSync(join(config, "machines.json"), "utf8"));
const source = hostname().split(".")[0].toLowerCase();
const flags = ["-a", "--delete", "--exclude", "node_modules", "--exclude", "*.test.mjs"];
if (args.includes("--help")) {
  console.log(
    "agent-kit/install.sh [--to ID[,ID]] [--apply] | --dest DIR\nRoutes and instruction sources: T3CTL_AGENTS_CONFIG or skills/t3/global.",
  );
} else if (args[0] === "--transport") {
  const target = machines().find((machine) => machine.id === args[1]);
  if (!target) throw new Error("Unknown machine " + args[1]);
  // rsync supplies a dummy destination followed by the remote command arguments.
  run("ssh", sshTransport(machines(), source, target, args.slice(3).map(shellQuote).join(" ")));
} else if (option("--dest")) {
  const dest = resolve(option("--dest"));
  mkdirSync(dest, { recursive: true });
  run("rsync", [...flags, skill + "/", dest + "/"]);
  console.log("skill copied to " + dest);
} else {
  const registry = machines();
  const ids = option("--to")?.split(",") ?? registry.map((machine) => machine.id);
  const selected = ids.map((id) => {
    const machine = registry.find((entry) => entry.id === id);
    if (!machine) throw new Error("Unknown machine " + id);
    return machine;
  });
  const apply = args.includes("--apply");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const machine of selected) {
    const local = machine.id === source;
    const target = ".agents/skills/t3";
    const backup = `.local/state/t3-agent-kit/${stamp}/skill-t3`;
    if (apply) {
      const command = `mkdir -p "$HOME/${backup}" && if [ -d "$HOME/${target}" ]; then cp -a "$HOME/${target}/." "$HOME/${backup}/"; fi && mkdir -p "$HOME/${target}"`;
      if (local) run("sh", ["-c", command]);
      else run("ssh", sshTransport(registry, source, machine, command));
    }
    console.log(`${machine.id}: ${apply ? "installing (backup " + backup + ")" : "dry run"}`);
    const temp = mkdtempSync(join(tmpdir(), "t3-kit-transport-"));
    try {
      // Keep rsync's command transport independent of path whitespace and SSH topology.
      const wrapper = join(temp, "ssh");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        wrapper,
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} --transport ${shellQuote(machine.id)} "$@"\n`,
        { mode: 0o700 },
      );
      run("rsync", [
        ...flags,
        ...(apply ? [] : ["-n", "--itemize-changes"]),
        ...(local ? [] : ["-e", shellQuote(wrapper)]),
        skill + "/",
        local ? join(homedir(), target) + "/" : `target:${target}/`,
      ]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  runAgents(["sync"], { to: ids.join(","), apply, config });
}
