import { app, BrowserWindow, protocol, ipcMain } from "electron";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as EP from "../src/electron/ElectronProtocol.ts";
import * as Ipc from "../src/ipc/DesktopIpc.ts";
import { authorizeDesktopIpc } from "../src/ipc/rendererTrust.ts";
import * as Channels from "../src/ipc/channels.ts";

const output = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hostile-ui-"));
app.setPath("userData", NodePath.join(output, "profile"));
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([
  { scheme: "t3code", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

async function main() {
  await app.whenReady();
  const assets = NodePath.join(output, "bundled");
  await NodeFSP.mkdir(assets);
  await NodeFSP.writeFile(NodePath.join(assets, "index.html"), "<h1>Bundled UI</h1>");
  const preload = NodePath.join(output, "preload.cjs");
  const require = NodeModule.createRequire(import.meta.url);
  const esbuild = require(
    NodeModule.createRequire(require.resolve("vite-plus/package.json")).resolve("esbuild"),
  );
  await esbuild.build({
    entryPoints: [NodePath.resolve("apps/desktop/src/preload.ts")],
    outfile: preload,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  await NodeFSP.appendFile(
    preload,
    '\nrequire("electron").contextBridge.exposeInMainWorld("attack",channel=>require("electron").ipcRenderer.invoke(channel));',
  );
  let compatible = true;
  const hostile = NodeHttp.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html",
      ...(compatible ? { "t3-desktop-ui-protocol": "1", "t3-desktop-bridge": "reduced-1" } : {}),
    });
    response.end("<h1>Hostile server UI</h1>");
  });
  await new Promise((resolve) => hostile.listen(0, "127.0.0.1", resolve));
  let origin = new URL(`http://127.0.0.1:${hostile.address().port}/`);
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ipc = Ipc.make(ipcMain, (event, channel) =>
            authorizeDesktopIpc(event, channel, window.webContents.getURL()),
          );
          const privileged = [
            Channels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL,
            Channels.GET_CONNECTION_CATALOG_CHANNEL,
            Channels.SET_CONNECTION_CATALOG_CHANNEL,
            Channels.ENSURE_SSH_ENVIRONMENT_CHANNEL,
            Channels.SET_SERVER_EXPOSURE_MODE_CHANNEL,
            Channels.READ_MEDIA_CHANNEL,
            Channels.OPEN_EXTERNAL_CHANNEL,
          ];
          let calls = 0;
          for (const channel of privileged)
            yield* ipc.handle({
              channel,
              handler: () =>
                Effect.sync(() => {
                  calls++;
                  return "credential-fixture";
                }),
            });
          yield* ipc.handle({
            channel: Channels.REVEAL_WINDOW_CHANNEL,
            handler: () => Effect.void,
          });
          yield* ipc.handleSync({
            channel: Channels.TAKE_LEGACY_LOCAL_STORAGE_CHANNEL,
            handler: () => Effect.succeed(null),
          });
          const protocolService = yield* EP.ElectronProtocol;
          yield* ipc.handleSync({
            channel: Channels.UI_SERVER_ORIGIN_CHANNEL,
            handler: (event) => protocolService.serverOriginFor(event.sender.id),
          });
          yield* ipc.handleSync({
            channel: Channels.UI_SERVER_NAME_CHANNEL,
            handler: () => Effect.succeed("Studio"),
          });
          yield* protocolService.trackWindow(window.webContents);
          yield* protocolService.registerDesktopProtocol({
            scheme: "t3code",
            assetDirectory: assets,
            serverOrigin: async () => origin,
            connectionOrigins: async () => [origin.origin],
            clerkFrontendApiHostname: undefined,
          });
          yield* Effect.promise(async () => {
            await window.loadURL(`t3code://app/?desktopWindowId=${window.webContents.id}`);
            NodeAssert.match(window.webContents.getURL(), /server-/);
            NodeAssert.equal(await evaluate("typeof window.desktopBridge"), "undefined");
            NodeAssert.equal(await evaluate("typeof window.desktopShell.revealWindow"), "function");
            NodeAssert.equal(await evaluate("window.desktopShell.origin"), origin.href);
            NodeAssert.equal(await evaluate("window.desktopShell.name"), "Studio");
            for (const channel of privileged) {
              const refused = await evaluate(
                `window.attack(${JSON.stringify(channel)}).then(()=>false,()=>true)`,
              );
              NodeAssert.equal(refused, true, channel);
            }
            NodeAssert.equal(calls, 0);
            const policy = await evaluate('document.querySelector("h1").textContent');
            NodeAssert.equal(policy, "Hostile server UI");
            await evaluate('localStorage.setItem("hostile-marker","present")');
            const firstServerPage = window.webContents.getURL();
            const firstOrigin = origin;
            origin = new URL("other/", origin);
            await window.loadURL(firstServerPage);
            NodeAssert.notEqual(
              new URL(window.webContents.getURL()).host,
              new URL(firstServerPage).host,
            );
            NodeAssert.equal(await evaluate('localStorage.getItem("hostile-marker")'), null);
            origin = firstOrigin;
            await window.loadURL(window.webContents.getURL());
            NodeAssert.equal(await evaluate('localStorage.getItem("hostile-marker")'), "present");
            const returned = new Promise((resolve) =>
              window.webContents.once("did-finish-load", resolve),
            );
            await evaluate("window.desktopShell.returnToBundled()");
            await returned;
            NodeAssert.match(window.webContents.getURL(), /app\/.*bundled=1/);
            NodeAssert.equal(await evaluate('localStorage.getItem("hostile-marker")'), null);
            await window.loadURL(`t3code://app/?desktopWindowId=${window.webContents.id}`);
            NodeAssert.equal(await evaluate('localStorage.getItem("hostile-marker")'), "present");
            compatible = false;
            await window.loadURL(firstServerPage);
            NodeAssert.match(window.webContents.getURL(), /app\/.*bundled=1/);
            NodeAssert.equal(await evaluate('localStorage.getItem("hostile-marker")'), null);
            NodeAssert.equal(
              await evaluate("typeof window.desktopBridge.getLocalEnvironmentBearerToken"),
              "function",
            );
            NodeAssert.equal(
              await evaluate(`window.attack(${JSON.stringify(privileged[0])})`),
              "credential-fixture",
            );
            console.log(
              JSON.stringify({
                hostileServer: "denied",
                privilegedChannels: privileged.length,
                storage: "isolated by window and source",
                incompatibleServer: "bundled fallback",
                output,
              }),
            );
          });
        }).pipe(Effect.provide(EP.layer), Effect.provide(NodeServices.layer)),
      ),
    );
  } finally {
    window.destroy();
    await new Promise((resolve) => hostile.close(resolve));
  }
}
void main().then(
  () => app.quit(),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
