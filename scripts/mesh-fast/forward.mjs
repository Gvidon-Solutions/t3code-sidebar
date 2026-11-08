import * as NodeNet from "node:net";
const [port, host, target, listen = "127.0.0.1"] = process.argv.slice(2);
const sockets = new Set();
const server = NodeNet.createServer((local) => {
  const remote = NodeNet.connect(Number(target), host);
  sockets.add(local);
  sockets.add(remote);
  local.on("error", () => remote.destroy());
  remote.on("error", () => local.destroy());
  local.on("close", () => {
    sockets.delete(local);
    remote.destroy();
  });
  remote.on("close", () => {
    sockets.delete(remote);
    local.destroy();
  });
  local.pipe(remote);
  remote.pipe(local);
});
server.listen(Number(port), listen);
process.on("SIGTERM", () => {
  server.close();
  for (const socket of sockets) socket.destroy();
});
