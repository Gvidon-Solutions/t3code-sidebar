import { readLine } from "../platform/readLine.ts";
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
  const request = (async () => {
    const socket = NodeNet.connect(address);
    socket.once("connect", () =>
      socket.write(
        `${JSON.stringify({ action, cwd, timeoutMs, tty: Boolean(process.stdin.isTTY) })}\n`,
      ),
    );
    try {
      return decodeResponse(
        await readLine(socket, { maxBytes: 1048576, timeoutMs: timeoutMs + 5000 }),
      );
    } finally {
      socket.destroy();
    }
  })();
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
      if (match?.lite)
        return {
          ok: false,
          code: 75,
          message: "The local T3 server is unavailable; cannot synchronize this lite replica.",
        } as const;
    } catch {
      return {
        ok: false,
        code: 75,
        message:
          "The local T3 server and representation manifest are unavailable; cannot prove this directory is outside a replica.",
      } as const;
    }
    return { ok: true, plan: { kind: "local" }, remoteCommands: DEFAULT_REMOTE_COMMANDS } as const;
  });
}
