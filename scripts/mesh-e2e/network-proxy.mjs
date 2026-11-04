#!/usr/bin/env node
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";

const [listen, backend, stateFile, host = "127.0.0.1", backendHost = "127.0.0.1"] =
  process.argv.slice(2);
if (!listen || !backend || !stateFile)
  throw new Error("Usage: network-proxy.mjs LISTEN_PORT BACKEND_PORT STATE_FILE");
const sockets = new Set();
const counts = { mcp: 0, refusedMcp: 0, upgrades: 0, refusedUpgrades: 0 };
let state = { denyMcp: false, cut: false };
function refresh() {
  try {
    state = JSON.parse(NodeFS.readFileSync(stateFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.error("N1 proxy state:", error);
  }
  if (state.cut) for (const socket of sockets) socket.destroy();
}
NodeFS.watchFile(stateFile, { interval: 200 }, refresh);
refresh();
const server = NodeHttp.createServer((request, response) => {
  if (request.url === "/__N1_network") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...counts, state, sockets: sockets.size }));
    return;
  }
  refresh();
  const mcp = request.method === "POST" && request.url?.split("?")[0] === "/mcp";
  if (mcp) counts.mcp++;
  if (state.cut || (mcp && state.denyMcp)) {
    if (mcp) counts.refusedMcp++;
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("N1 injected network failure");
    return;
  }
  const outgoing = NodeHttp.request(
    {
      host: backendHost,
      port: Number(backend),
      path: request.url,
      method: request.method,
      headers: request.headers,
    },
    (incoming) => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    },
  );
  outgoing.on("error", (error) => {
    response.writeHead(502);
    response.end(error.message);
  });
  request.pipe(outgoing);
});
server.on("upgrade", (request, socket, head) => {
  refresh();
  if (state.cut) {
    counts.refusedUpgrades++;
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return;
  }
  const outgoing = NodeHttp.request({
    host: backendHost,
    port: Number(backend),
    path: request.url,
    headers: request.headers,
  });
  outgoing.on("upgrade", (response, remote, remoteHead) => {
    refresh();
    if (state.cut) {
      socket.destroy();
      remote.destroy();
      return;
    }
    counts.upgrades++;
    sockets.add(socket);
    sockets.add(remote);
    const headers = [];
    for (let i = 0; i < response.rawHeaders.length; i += 2)
      headers.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
    socket.write(
      `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${headers.join("\r\n")}\r\n\r\n`,
    );
    if (head.length) remote.write(head);
    if (remoteHead.length) socket.write(remoteHead);
    socket.on("close", () => {
      sockets.delete(socket);
      remote.destroy();
    });
    remote.on("close", () => {
      sockets.delete(remote);
      socket.destroy();
    });
    socket.on("error", (error) => remote.destroy(error));
    remote.on("error", () => socket.destroy());
    socket.pipe(remote);
    remote.pipe(socket);
  });
  outgoing.on("response", (incoming) => {
    socket.write(
      `HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\nConnection: close\r\n\r\n`,
    );
    incoming.pipe(socket);
  });
  outgoing.on("error", () => socket.destroy());
  outgoing.end();
});
server.listen(Number(listen), host, () => console.log(`N1 proxy ${listen} -> loopback:${backend}`));
process.on("SIGTERM", () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
  NodeFS.unwatchFile(stateFile);
});
