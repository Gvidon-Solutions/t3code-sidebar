import { app, BrowserWindow, protocol } from "electron";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as EP from "../src/electron/ElectronProtocol.ts";
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([
  { scheme: "t3code", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
async function main() {
  await app.whenReady();
  const output = NodeURL.pathToFileURL(
    (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-delivery-desktop-"))) + "/",
  );
  console.log(output.pathname);
  const root = new URL("./offline/", output);
  await NodeFSP.mkdir(root, { recursive: true });
  await NodeFSP.writeFile(new URL("index.html", root), "<h1>D1 bundled offline</h1>");
  let version = "D1 server v1";
  const server = NodeHttp.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(`<h1>${version}</h1>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = new URL(`http://127.0.0.1:${server.address().port}`);
  const win = new BrowserWindow({
    show: true,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* EP.ElectronProtocol;
          yield* service.registerDesktopProtocol({
            scheme: "t3code",
            assetDirectory: root.pathname,
            serverOrigin: async () => origin,
            clerkFrontendApiHostname: undefined,
          });
          yield* Effect.promise(async () => {
            for (const expected of ["D1 server v1", "D1 server v2"]) {
              version = expected;
              await win.loadURL("t3code://app/");
              const actual = await win.webContents.executeJavaScript(
                'document.querySelector("h1").textContent',
              );
              if (actual !== expected) throw new Error(`${expected}: ${actual}`);
              console.log(actual);
              await NodeFSP.writeFile(
                new URL(
                  expected.endsWith("v1") ? "desktop-before.png" : "desktop-after.png",
                  output,
                ),
                (await win.webContents.capturePage()).toPNG(),
              );
            }
            await new Promise((resolve) => server.close(resolve));
            await win.loadURL("t3code://app/");
            const actual = await win.webContents.executeJavaScript(
              'document.querySelector("h1").textContent',
            );
            if (actual !== "D1 bundled offline") throw new Error(actual);
            console.log(actual);
          });
        }),
      ).pipe(Effect.provide(EP.layer.pipe(Layer.provide(NodeServices.layer)))),
    );
  } finally {
    win.destroy();
    server.close();
    app.quit();
  }
}
main().catch((error) => {
  console.error(error);
  app.exit(1);
});
