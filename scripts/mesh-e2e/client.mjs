import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let out = "",
      err = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(Error(`${command}: ${code}: ${err.slice(-2000)} ${out.slice(-1000)}`)),
    );
  });

const until = async (description, read, accepts, timeout = 120000) => {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    try {
      value = await read();
      if (accepts(value)) return value;
    } catch (error) {
      value = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Error(`${description}: ${JSON.stringify(value).slice(-3000)}`);
};

const rpc = async (node, tag, payload = {}) => {
  const response = await fetch(`${node.origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${node.token}` },
  });
  if (!response.ok) throw Error(`Ticket ${node.name}: ${response.status}`);
  const { ticket } = await response.json();
  const ws = new WebSocket(
    `${node.origin.replace("http:", "ws:")}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=2&clientSurface=cli`,
  );
  await NodeEvents.once(ws, "open");
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`RPC ${tag} deadline`)), 30000);
      ws.onmessage = (event) => {
        for (const line of String(event.data).split("\n")) {
          if (!line) continue;
          const message = JSON.parse(line);
          if (message._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
          if (message._tag === "Exit" && message.requestId === "B1") {
            clearTimeout(timer);
            if (message.exit._tag === "Success") resolve(message.exit.value);
            else reject(Error(JSON.stringify(message.exit.cause)));
          }
        }
      };
      ws.send(JSON.stringify({ _tag: "Request", id: "B1", tag, payload, headers: [] }));
    });
  } finally {
    ws.close();
  }
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
        signal: AbortSignal.timeout(15000),
      });
      const value = await response.json();
      if (!response.ok) throw Error(`OAuth ${path}: ${JSON.stringify(value)}`);
      return value;
    };
    const pair = JSON.parse(
      await node.cli(["auth", "pairing", "create", "--ttl", "10m", "--label", "B1-mcp", "--json"]),
    );
    const meta = await json("/.well-known/oauth-protected-resource/mcp");
    const redirect = "http://127.0.0.1:1/B1-callback";
    const client = await json("/oauth/mcp/register", {
      client_name: "B1-bed",
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
      headers: {
        authorization: `Bearer ${node.mcpToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "B1-init",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "B1-bed", version: "1" },
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
    headers: {
      authorization: `Bearer ${node.mcpToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(node.mcpSession ? { "mcp-session-id": node.mcpSession } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "B1",
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
