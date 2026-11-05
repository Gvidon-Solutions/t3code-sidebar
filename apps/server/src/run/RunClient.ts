// @effect-diagnostics nodeBuiltinImport:off -- The runtime CLI uses the same private local socket on POSIX and Windows.
import * as NodeFSP from "node:fs/promises";
import * as Schema from "effect/Schema";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { runAddress } from "../platform/ServerPlatform.ts";
import {
  decodeResponse,
  CommandManifest,
  DEFAULT_REMOTE_COMMANDS,
  type RunResponse,
} from "./RunProtocol.ts";
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(CommandManifest));

export function requestRun(
  action: "resolve" | "prepare" | "finish",
  cwd: string,
  timeoutMs = 30000,
): Promise<Schema.Schema.Type<typeof RunResponse>> {
  const address =
    process.env.T3CODE_RUN_SOCKET ??
    runAddress(process.env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".t3-sidebar"));
  const request = new Promise<Schema.Schema.Type<typeof RunResponse>>((resolve, reject) => {
    const socket = NodeNet.connect(address);
    let input = "";
    const finish = (cause: Error) => {
      socket.destroy();
      reject(cause);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs + 5000, () =>
      finish(new Error("The local T3 run request timed out.")),
    );
    socket.once("error", finish);
    socket.once("connect", () =>
      socket.write(
        `${JSON.stringify({ action, cwd, timeoutMs, tty: Boolean(process.stdin.isTTY) })}\n`,
      ),
    );
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > 1048576) {
        finish(new Error("The local T3 run response is too large."));
        return;
      }
      const end = input.indexOf("\n");
      if (end < 0) return;
      try {
        const response = decodeResponse(input.slice(0, end));
        socket.destroy();
        resolve(response);
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error("Invalid run response"));
      }
    });
    socket.once("end", () => {
      if (!input.includes("\n")) finish(new Error("The local T3 server closed the run request."));
    });
  });
  return request.catch(async (cause: unknown) => {
    if (
      action !== "resolve" ||
      !(cause instanceof Error) ||
      !("code" in cause) ||
      !["ENOENT", "ECONNREFUSED"].includes(String(cause.code))
    )
      throw cause;
    const manifestPath =
      process.env.T3CODE_RUN_MANIFEST ??
      NodePath.join(
        process.env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".t3-sidebar"),
        "run",
        "manifest.json",
      );
    try {
      const manifest = decodeManifest(await NodeFSP.readFile(manifestPath, "utf8"));
      const match = manifest.representations
        .filter((rep) => {
          const relative = NodePath.relative(rep.root, cwd);
          return (
            relative !== ".." &&
            !relative.startsWith(`..${NodePath.sep}`) &&
            !NodePath.isAbsolute(relative)
          );
        })
        .sort((a, b) => b.root.length - a.root.length)[0];
      if (match?.lite) throw cause;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT" &&
          !process.env.T3CODE_RUN_SOCKET
        )
      )
        throw error;
    }
    return { ok: true, plan: { kind: "local" }, remoteCommands: DEFAULT_REMOTE_COMMANDS } as const;
  });
}
