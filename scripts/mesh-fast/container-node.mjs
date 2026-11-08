import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeFS from "node:fs";
const [file] = process.argv.slice(2),
  config = JSON.parse(NodeFS.readFileSync(file, "utf8"));
const children = [],
  sockets = new Set(),
  servers = [];
function launch(args) {
  const child = NodeChildProcess.spawn(args[0], args.slice(1), { stdio: "inherit" });
  children.push(child);
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  return child;
}
for (const { port, target } of config.routes) {
  const server = NodeNet.createServer((socket) => {
    const outgoing = NodeNet.connect(target, "host.docker.internal");
    sockets.add(socket);
    sockets.add(outgoing);
    socket.on("error", () => outgoing.destroy());
    outgoing.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      outgoing.destroy();
    });
    outgoing.on("close", () => {
      sockets.delete(outgoing);
      socket.destroy();
    });
    socket.pipe(outgoing);
    outgoing.pipe(socket);
  });
  servers.push(server);
  server.listen(port, "127.0.0.1");
}
for (const args of config.children) launch(args);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    for (const server of servers) server.close();
    for (const socket of sockets) socket.destroy();
    for (const child of children) {
      child.kill("SIGCONT");
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, 2000).unref();
  });
