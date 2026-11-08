import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
export async function nightly({
  directory,
  command,
  inboxCommand,
  inboxBodyViaStdin = false,
  timeoutMs = 3 * 60 * 60 * 1000,
}) {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await NodeFSP.open(NodePath.join(directory, "latest.log"), "w", 0o600);
  const startedAt = new Date().toISOString();
  let error;
  try {
    await new Promise((resolve, reject) => {
      const child = NodeChildProcess.spawn(command[0], command.slice(1), {
        stdio: ["ignore", log.fd, log.fd],
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(Error("Nightly exceeded its execution deadline"));
      }, timeoutMs);
      child.once("error", (cause) => {
        clearTimeout(timer);
        reject(cause);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(Error(`Nightly exited ${code ?? signal}`));
      });
    });
  } catch (cause) {
    error = cause.message ?? String(cause);
  } finally {
    await log.close();
  }
  const summary = {
    state: error ? "FAIL" : "PASS",
    startedAt,
    finishedAt: new Date().toISOString(),
    error: error ?? null,
    log: NodePath.join(directory, "latest.log"),
  };
  await NodeFSP.writeFile(
    NodePath.join(directory, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "summary.md"),
    `Mesh nightly: ${summary.state}\n\nStarted: ${startedAt}\nFinished: ${summary.finishedAt}\n${error ?? "All realistic scenarios passed."}\nLog: ${summary.log}\n`,
  );
  if (error) {
    const body = await NodeFSP.readFile(NodePath.join(directory, "summary.md"), "utf8");
    await new Promise((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        inboxCommand[0],
        inboxBodyViaStdin
          ? inboxCommand.slice(1)
          : [
              ...inboxCommand.slice(1),
              "inbox",
              "post",
              "attention",
              "Mesh nightly failed",
              "--body",
              body,
              "--key",
              "mesh-nightly",
            ],
        { stdio: inboxBodyViaStdin ? ["pipe", "inherit", "inherit"] : "inherit" },
      );
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(Error("Could not post nightly failure to the T3 inbox: " + code)),
      );
      if (inboxBodyViaStdin) {
        child.stdin.once("error", reject);
        child.stdin.end(body);
      }
    });
  }
  return summary;
}
if (import.meta.main) {
  const config = JSON.parse(await NodeFSP.readFile(process.argv[2], "utf8"));
  const result = await nightly(config);
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.state === "PASS" ? 0 : 1;
}
