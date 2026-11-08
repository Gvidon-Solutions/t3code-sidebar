#!/usr/bin/env node
import WebSocket, { WebSocketServer } from "ws";
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";

const [listen, backend, stateFile, host = "127.0.0.1", backendHost = "127.0.0.1"] =
  process.argv.slice(2);
if (!listen || !backend || !stateFile)
  throw new Error("Usage: network-proxy.mjs LISTEN_PORT BACKEND_PORT STATE_FILE");
const sockets = new Set();
const peerSockets = new Set();
const held = new Set();
const messageServer = new WebSocketServer({ noServer: true });
let commitDropped = false;
const counts = {
  resets: 0,
  droppedCommitResponses: 0,
  commitCalls: 0,
  bytes: 0,
  pipeBytes: 0,
  idleDrops: 0,
  peerIdleDrops: 0,
  peerResets: 0,
  mcp: 0,
  refusedMcp: 0,
  peerMcp: 0,
  refusedPeerMcp: 0,
  upgrades: 0,
  refusedUpgrades: 0,
};
let state = { denyMcp: false, cut: false };
function refresh() {
  try {
    state = JSON.parse(NodeFS.readFileSync(stateFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.error("N1 proxy state:", error);
  }
  if (state.cut || state.reset)
    for (const socket of sockets) {
      counts.resets++;
      if (peerSockets.has(socket)) counts.peerResets++;
      socket.resetAndDestroy();
    }
  if (!state.pauseAfterBytes && !state.pausePipeAfterBytes)
    for (const release of held) {
      held.delete(release);
      release();
    }
  for (const socket of sockets)
    socket.setTimeout(state.idleMs ?? 0, () => {
      counts.idleDrops++;
      if (peerSockets.has(socket)) counts.peerIdleDrops++;
      socket.destroy();
    });
}
NodeFS.watchFile(stateFile, { interval: 200 }, refresh);
refresh();
const server = NodeHttp.createServer((request, response) => {
  if (request.url === "/__N1_network") {
    refresh();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...counts, state, sockets: sockets.size }));
    return;
  }
  refresh();
  const mcp = request.method === "POST" && request.url?.split("?")[0] === "/mcp";
  const peer = request.url?.split("?")[0] === "/peer";
  const peerMcp = mcp && typeof request.headers["t3-peer-environment-id"] === "string";
  if (mcp) counts.mcp++;
  if (peerMcp) counts.peerMcp++;
  if (
    state.cut ||
    (mcp && state.denyMcp && (!state.peerOnlyMcp || peerMcp)) ||
    (peer && state.denyPeer)
  ) {
    if (mcp) counts.refusedMcp++;
    if (peerMcp) counts.refusedPeerMcp++;
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("N1 injected network failure");
    return;
  }
  const outgoing = NodeHttp.request(
    {
      host: state.backendHost ?? backendHost,
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
  if (state.cut || (state.denyPeer && request.url?.split("?")[0] === "/peer")) {
    counts.refusedUpgrades++;
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return;
  }
  if ((state.observeCommit || state.inspectPipe) && request.url?.split("?")[0] === "/peer") {
    messageServer.handleUpgrade(request, socket, head, (incoming) => {
      const headers = Object.fromEntries(
        Object.entries(request.headers).filter(
          ([key]) =>
            ![
              "host",
              "connection",
              "upgrade",
              "sec-websocket-key",
              "sec-websocket-version",
              "sec-websocket-extensions",
              "sec-websocket-protocol",
            ].includes(key),
        ),
      );
      const remote = new WebSocket(
        "ws://" + (state.backendHost ?? backendHost) + ":" + backend + request.url,
        { headers },
      );
      const pending = [];
      const commits = new Set();
      counts.upgrades++;
      sockets.add(socket);
      peerSockets.add(socket);
      const send = (to, bytes, binary, frame) => {
        const deliver = () => {
          if (to.readyState === WebSocket.OPEN) to.send(bytes, { binary });
        };
        if (frame?.type === "data") {
          counts.pipeBytes += Buffer.from(frame.data, "base64").length;
          if (state.pausePipeAfterBytes && counts.pipeBytes >= state.pausePipeAfterBytes) {
            held.add(deliver);
            return;
          }
        }
        deliver();
      };
      incoming.on("message", (bytes, binary) => {
        const frame = binary ? undefined : JSON.parse(bytes.toString());
        if (
          frame?.type === "call" &&
          frame.body?.tool === "t3_thread_receive_fork" &&
          frame.body.arguments?.action === "commit"
        ) {
          commits.add(frame.id);
          counts.commitCalls++;
        }
        if (remote.readyState === WebSocket.OPEN) send(remote, bytes, binary, frame);
        else pending.push([bytes, binary]);
      });
      remote.on("open", () => {
        for (const [bytes, binary] of pending) remote.send(bytes, { binary });
        pending.length = 0;
      });
      remote.on("message", (bytes, binary) => {
        const frame = binary ? undefined : JSON.parse(bytes.toString());
        if (!commitDropped && frame?.type === "result" && commits.has(frame.id)) {
          commitDropped = true;
          counts.droppedCommitResponses++;
          incoming.terminate();
          remote.terminate();
          return;
        }
        if (incoming.readyState === WebSocket.OPEN) send(incoming, bytes, binary, frame);
      });
      incoming.on("close", () => {
        sockets.delete(socket);
        peerSockets.delete(socket);
        remote.terminate();
      });
      remote.on("close", () => incoming.terminate());
      incoming.on("error", () => remote.terminate());
      remote.on("error", () => incoming.terminate());
    });
    return;
  }
  const outgoing = NodeHttp.request({
    host: state.backendHost ?? backendHost,
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
    if (request.url?.split("?")[0] === "/peer") {
      peerSockets.add(socket);
      peerSockets.add(remote);
    }
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
      peerSockets.delete(socket);
      remote.destroy();
    });
    remote.on("close", () => {
      sockets.delete(remote);
      peerSockets.delete(remote);
      socket.destroy();
    });
    socket.on("error", (error) => remote.destroy(error));
    remote.on("error", () => socket.destroy());
    const forward = (from, to) =>
      from.on("data", (bytes) => {
        from.pause();
        counts.bytes += bytes.length;
        if (state.resetAfterBytes && counts.bytes >= state.resetAfterBytes) {
          counts.resets++;
          socket.resetAndDestroy();
          remote.resetAndDestroy();
          return;
        }
        const release = () =>
          setTimeout(() => {
            if (!to.destroyed) to.write(bytes, () => from.resume());
          }, state.delayMs ?? 0);
        if (state.pauseAfterBytes && counts.bytes >= state.pauseAfterBytes) held.add(release);
        else release();
      });
    forward(socket, remote);
    forward(remote, socket);
    socket.on("end", () => remote.end());
    remote.on("end", () => socket.end());
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
