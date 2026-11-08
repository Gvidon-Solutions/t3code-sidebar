import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
const sessions = new Map(),
  pending = new Map();
let nextRequest = 0;
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = "fixture-" + ++nextRequest;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = (sessionId, text) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
async function handle(message) {
  const p = message.params ?? {};
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { acp: true },
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        authMethods: [],
        agentInfo: { name: "mesh-fast", version: "1" },
      };
    case "session/new":
    case "session/load": {
      const sessionId = p.sessionId ?? NodeCrypto.randomUUID();
      sessions.set(sessionId, { cwd: p.cwd ?? process.cwd() });
      return {
        ...(message.method === "session/new" ? { sessionId } : {}),
        models: {
          currentModelId: "fast",
          availableModels: [{ modelId: "fast", name: "Deterministic mesh fixture" }],
        },
      };
    }
    case "session/set_model":
    case "session/set_mode":
    case "authenticate":
      return {};
    case "session/close":
      sessions.get(p.sessionId)?.cancel?.();
      sessions.delete(p.sessionId);
      return {};
    case "session/prompt": {
      const session = sessions.get(p.sessionId);
      if (!session) throw Error("Unknown fixture session");
      const text = (p.prompt ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const marker = /FAST_WRITE:([a-z0-9-]+)/.exec(text)?.[1];
      if (text.includes("FAST_SELF")) {
        const { connectionId } = await call("mcp/connect", { serverId: "t3-code" });
        await call("mcp/message", {
          connectionId,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "mesh-fast", version: "1" },
          },
        });
        send({
          method: "mcp/message",
          params: { connectionId, method: "notifications/initialized" },
        });
        const value = await call("mcp/message", {
          connectionId,
          method: "tools/call",
          params: { name: "t3_thread_self", arguments: {} },
        });
        update(p.sessionId, "FAST_SELF_JSON " + JSON.stringify(value));
        await call("mcp/disconnect", { connectionId });
      }
      if (text.includes("FAST_READ"))
        update(
          p.sessionId,
          "FAST_READ_BYTES " +
            NodeChildProcess.execFileSync("sh", ["-c", "cat README.md"], {
              cwd: session.cwd,
              encoding: "utf8",
            }),
        );
      if (marker) NodeFS.appendFileSync(NodePath.join(session.cwd, "README.md"), "\n" + marker);
      if (text.includes("FAST_HOLD")) {
        update(p.sessionId, "IN_PROGRESS");
        NodeFS.mkdirSync(NodePath.join(session.cwd, ".t3"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(session.cwd, ".t3/hold-ready"), "ready");
        await new Promise((resolve) => {
          const watch = NodeFS.watch(session.cwd, () => {
            if (NodeFS.existsSync(NodePath.join(session.cwd, ".fast-release"))) {
              watch.close();
              resolve();
            }
          });
          session.cancel = () => {
            watch.close();
            resolve();
          };
        });
      }
      update(p.sessionId, "FAST_DONE " + (marker ?? "fixture"));
      return { stopReason: "end_turn" };
    }
    default:
      throw Error("Unsupported fixture method: " + message.method);
  }
}
NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    const request = pending.get(message.id);
    if (!request) throw Error("Unexpected ACP response");
    pending.delete(message.id);
    if (message.error) request.reject(Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
    return;
  }
  if (message.id === undefined) {
    if (message.method === "session/cancel") sessions.get(message.params.sessionId)?.cancel?.();
    return;
  }
  handle(message).then(
    (result) => send({ id: message.id, result }),
    (error) => send({ id: message.id, error: { code: -32603, message: error.message } }),
  );
});
