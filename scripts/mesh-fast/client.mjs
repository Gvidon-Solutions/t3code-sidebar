import { run, until } from "../lib/shell.mjs";
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
async function connectRpc(node, key) {
  const response = await fetch(node.origin + "/api/auth/websocket-ticket", {
    method: "POST",
    signal: AbortSignal.timeout(120000),
    headers: { authorization: "Bearer " + node.token },
  });
  if (!response.ok) throw Error("Ticket " + node.name + ": " + response.status);
  const { ticket } = await response.json();
  const ws = new WebSocket(
    node.origin.replace("http:", "ws:") +
      "/ws?wsTicket=" +
      encodeURIComponent(ticket) +
      "&orchestrationProtocol=2&clientSurface=cli",
  );
  await NodeEvents.once(ws, "open");
  const pending = new Map();
  let sequence = 0;
  const connection = { key, ws, call };
  function fail(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    if (node.rpcConnection === connection) delete node.rpcConnection;
  }
  ws.onclose = (event) => fail(Error("RPC connection closed: " + event.code));
  ws.onerror = () => fail(Error("RPC connection failed"));
  ws.onmessage = (event) => {
    try {
      for (const line of String(event.data).split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line);
        if (message._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
        const request = pending.get(message.requestId);
        if (!request) continue;
        if (message._tag === "Chunk" && message.values.length) {
          pending.delete(message.requestId);
          clearTimeout(request.timer);
          ws.send(JSON.stringify({ _tag: "Interrupt", requestId: message.requestId }));
          request.resolve(message.values[0]);
        } else if (message._tag === "Exit") {
          pending.delete(message.requestId);
          clearTimeout(request.timer);
          if (message.exit._tag === "Success") request.resolve(message.exit.value);
          else request.reject(Error(JSON.stringify(message.exit.cause)));
        }
      }
    } catch (error) {
      fail(error);
      ws.close();
    }
  };
  function call(tag, payload) {
    return new Promise((resolve, reject) => {
      const id = "fast-" + ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("RPC " + tag + " deadline"));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }
  node.rpcConnection = connection;
  return connection;
}
const rpc = async (node, tag, payload = {}) => {
  const key = node.origin + "\0" + node.token;
  let connection = node.rpcConnection;
  if (connection?.key !== key || connection.ws.readyState !== WebSocket.OPEN) {
    if (node.rpcConnecting?.key !== key) {
      const connecting = { key, promise: connectRpc(node, key) };
      node.rpcConnecting = connecting;
      connecting.promise = connecting.promise.then(
        (value) => {
          if (node.rpcConnecting === connecting) delete node.rpcConnecting;
          return value;
        },
        (error) => {
          if (node.rpcConnecting === connecting) delete node.rpcConnecting;
          throw error;
        },
      );
    }
    connection = await node.rpcConnecting.promise;
  }
  return connection.call(tag, payload);
};
const mcp = async (node, name, args = {}) => {
  if (!node.mcpToken) {
    const json = async (path, body, form = false) => {
      const response = await fetch(`${node.origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: body
          ? { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" }
          : {},
        body: body ? (form ? new URLSearchParams(body) : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(120000),
      });
      const value = await response.json();
      if (!response.ok) throw Error(`OAuth ${path}: ${JSON.stringify(value)}`);
      return value;
    };
    const pair = JSON.parse(
      await node.cli([
        "auth",
        "pairing",
        "create",
        "--ttl",
        "10m",
        "--label",
        "mesh-fast-mcp",
        "--json",
      ]),
    );
    const meta = await json("/.well-known/oauth-protected-resource/mcp");
    const redirect = "http://127.0.0.1:1/mesh-fast-callback";
    const client = await json("/oauth/mcp/register", {
      client_name: "mesh-fast-bed",
      redirect_uris: [redirect],
    });
    const verifier = NodeCrypto.randomBytes(32).toString("base64url");
    const authorization = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirect,
      code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: NodeCrypto.randomBytes(8).toString("hex"),
      resource: meta.resource,
    };
    const decision = await json("/oauth/mcp/decision", {
      authorization,
      decision: { _tag: "pairing-code", access: "full-access", code: pair.credential },
    });
    const code = new URL(decision.redirectTo).searchParams.get("code");
    const token = await json(
      "/oauth/mcp/token",
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: meta.resource,
      },
      true,
    );
    node.mcpToken = token.access_token;
  }
  if (!node.mcpInitialized) {
    const initialized = await fetch(`${node.origin}/mcp`, {
      method: "POST",
      signal: AbortSignal.timeout(120000),
      headers: {
        authorization: `Bearer ${node.mcpToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "mesh-fast-init",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mesh-fast-bed", version: "1" },
        },
      }),
    });
    if (!initialized.ok)
      throw Error(`MCP initialize: ${initialized.status}: ${await initialized.text()}`);
    node.mcpSession = initialized.headers.get("mcp-session-id");
    node.mcpInitialized = true;
  }
  const response = await fetch(`${node.origin}/mcp`, {
    method: "POST",
    signal: AbortSignal.timeout(120000),
    headers: {
      authorization: `Bearer ${node.mcpToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(node.mcpSession ? { "mcp-session-id": node.mcpSession } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "mesh-fast",
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const source = await response.text();
  if (!response.ok) throw Error(`MCP ${name}: HTTP ${response.status}: ${source.slice(-2000)}`);
  const value = JSON.parse(
    source.startsWith("data:")
      ? source
          .split("\n")
          .find((line) => line.startsWith("data:"))
          .slice(5)
      : source,
  );
  if (value.error || value.result?.isError) throw Error(JSON.stringify(value).slice(-3000));
  return JSON.parse(
    value.result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
  );
};

export { run, until, rpc, mcp };
