// @effect-diagnostics nodeBuiltinImport:off -- The runtime CLI uses the same private local socket on POSIX and Windows.
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import type * as Schema from "effect/Schema";
import { runAddress } from "./RunPlatform.ts";
import { decodeResponse, type RunResponse } from "./RunProtocol.ts";
export function requestRun(
  action: "resolve" | "prepare" | "finish",
  cwd: string,
  timeoutMs = 30000,
): Promise<Schema.Schema.Type<typeof RunResponse>> {
  const address =
    process.env.T3CODE_RUN_SOCKET ??
    runAddress(process.env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".t3-sidebar"));
  return new Promise((resolve, reject) => {
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
    socket.once("connect", () => socket.write(`${JSON.stringify({ action, cwd, timeoutMs })}\n`));
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
}
