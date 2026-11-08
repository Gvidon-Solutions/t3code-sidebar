import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { productRoot } from "./paths.mjs";
const { installPublicRuntime, installSshRuntime } = await import(
  NodeURL.pathToFileURL(
    NodePath.join(productRoot, "agent-kit/skills/t3/scripts/server-runtime.mjs"),
  ).href
);
const { action, sshConfig, ...input } = JSON.parse(process.argv[2]);
let result;
if (action === "public") result = await installPublicRuntime(input);
else if (action === "ssh")
  result = installSshRuntime({
    ...input,
    run: (command, args, options) =>
      NodeChildProcess.execFileSync(command, ["-F", sshConfig, ...args], options),
  });
else throw Error("Unknown runtime installation action");
process.stdout.write(JSON.stringify(result) + "\n");
