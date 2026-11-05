/* oxlint-disable t3code/no-global-process-runtime -- The fast shim is a standalone executable and must inspect its own native PATH and cwd. */
// @effect-diagnostics nodeBuiltinImport:off -- This fast path must exec the real binary without loading provider or server modules.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
interface Representation {
  root: string;
  lite: boolean;
  title: string;
  machine: string;
}
interface Manifest {
  representations: Representation[];
  commands: string[];
}
const isManifest = (input: unknown): input is Manifest =>
  typeof input === "object" &&
  input !== null &&
  "commands" in input &&
  Array.isArray(input.commands) &&
  input.commands.every((v: unknown) => typeof v === "string") &&
  "representations" in input &&
  Array.isArray(input.representations) &&
  input.representations.every(
    (v: unknown) =>
      typeof v === "object" &&
      v !== null &&
      "root" in v &&
      typeof v.root === "string" &&
      "lite" in v &&
      typeof v.lite === "boolean" &&
      "title" in v &&
      typeof v.title === "string" &&
      "machine" in v &&
      typeof v.machine === "string",
  );
const word = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`).replaceAll("\n", "\\n").replaceAll("\r", "\\r")}'`;
export async function runShim(command: string, args: readonly string[]) {
  try {
    if (command === "t3" && args[0] === "run") {
      const { runCli } = await import("./RunCli.ts");
      await runCli(args.slice(1));
      return;
    }
    const manifest: unknown = JSON.parse(
      await NodeFSP.readFile(process.env.T3CODE_RUN_MANIFEST!, "utf8"),
    );
    if (!isManifest(manifest)) throw new Error("Invalid replica command manifest.");
    const cwd = process.cwd();
    const representation = manifest.representations
      .filter((rep) => {
        const relative = NodePath.relative(rep.root, cwd);
        return (
          relative !== ".." &&
          !relative.startsWith(`..${NodePath.sep}`) &&
          !NodePath.isAbsolute(relative)
        );
      })
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (representation?.lite && manifest.commands.includes(command)) {
      const title = representation.title.replace(/[\r\n]/g, " ");
      process.stderr.write(
        `This is a lite replica of ${title}; the environment is on ${representation.machine}. Use: t3 run ${[command, ...args].map(word).join(" ")}\n`,
      );
      process.exitCode = 127;
      return;
    }
    const excluded = NodePath.resolve(process.env.T3CODE_RUN_SHIMS!);
    const extensions =
      process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
    for (const directory of (process.env.PATH ?? "").split(NodePath.delimiter)) {
      if (NodePath.resolve(directory) === excluded) continue;
      for (const suffix of extensions) {
        const binary = NodePath.resolve(directory, command + suffix);
        try {
          await NodeFSP.access(binary, process.platform === "win32" ? 0 : 1);
        } catch (cause) {
          if (
            cause instanceof Error &&
            "code" in cause &&
            ["ENOENT", "EACCES", "ENOTDIR"].includes(String(cause.code))
          )
            continue;
          throw cause;
        }
        const environment = {
          ...process.env,
          PATH: (process.env.PATH ?? "")
            .split(NodePath.delimiter)
            .filter((item) => NodePath.resolve(item) !== excluded)
            .join(NodePath.delimiter),
        };
        if (process.execve && process.platform !== "win32") {
          process.execve(binary, [command, ...args], environment);
          return;
        }
        const child = NodeChildProcess.spawn(binary, args, {
          env: environment,
          stdio: "inherit",
          shell: /\.(cmd|bat)$/i.test(binary),
        });
        process.on("SIGINT", () => child.kill("SIGINT"));
        process.on("SIGTERM", () => child.kill("SIGTERM"));
        process.exitCode = await new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) =>
            resolve(code ?? 128 + (NodeOS.constants.signals[signal ?? "SIGTERM"] ?? 1)),
          );
        });
        return;
      }
    }
    process.stderr.write(`${command}: command not found\n`);
    process.exitCode = 127;
  } catch (cause) {
    process.stderr.write(
      `${cause instanceof Error ? cause.message.replace(/[\r\n]+/g, " ") : "Replica command check failed"}\n`,
    );
    process.exitCode = 127;
  }
}
