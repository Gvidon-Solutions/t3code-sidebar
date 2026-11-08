import { app, BrowserWindow, protocol, ipcMain } from "electron";
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as EP from "../src/electron/ElectronProtocol.ts";
import * as EW from "../src/electron/ElectronWindow.ts";
import * as Ui from "../src/app/DesktopUi.ts";
import * as UiIpc from "../src/ipc/methods/ui.ts";
import * as Ipc from "../src/ipc/DesktopIpc.ts";
import * as Environment from "../src/app/DesktopEnvironment.ts";
import * as Catalog from "../src/app/DesktopConnectionCatalogStore.ts";
import * as Exposure from "../src/backend/DesktopServerExposure.ts";

const output = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-delivery-desktop-"));
app.setPath("userData", NodePath.join(output, "profile"));
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([
  { scheme: "t3code", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

async function main() {
  await app.whenReady();
  console.log(output);
  const offline = NodePath.join(output, "offline");
  await NodeFSP.mkdir(offline);
  await NodeFSP.writeFile(NodePath.join(offline, "index.html"), "<h1>D1 bundled offline</h1>");
  const preload = NodePath.join(output, "preload.cjs");
  await NodeFSP.writeFile(
    preload,
    'const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("deliveryUi",{select:value=>ipcRenderer.invoke("desktop:ui:select",value),info:()=>ipcRenderer.invoke("desktop:ui:info")});',
  );
  let studioVersion = "D1 studio UI1";
  const studio = NodeHttp.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html",
      "cache-control": "no-store",
      "content-encoding": "gzip",
    });
    response.end(NodeZlib.gzipSync(`<h1>${studioVersion}</h1>`));
  });
  const cloudbox = NodeHttp.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end("<h1>D1 cloudbox UI1</h1>");
  });
  await new Promise((resolve) => studio.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => cloudbox.listen(0, "127.0.0.1", resolve));
  const studioOrigin = `http://127.0.0.1:${studio.address().port}`;
  const cloudboxOrigin = `http://127.0.0.1:${cloudbox.address().port}`;
  const entries = [
    { environmentId: "studio", httpBaseUrl: studioOrigin, serverVersion: studioVersion },
    { environmentId: "cloudbox", httpBaseUrl: cloudboxOrigin, serverVersion: "D1 cloudbox UI1" },
  ];
  const catalog = JSON.stringify({
    schemaVersion: 1,
    targets: entries.map((value) => ({
      _tag: "BearerConnectionTarget",
      environmentId: value.environmentId,
      connectionId: value.environmentId,
      label: value.environmentId,
    })),
    profiles: entries.map((value) => ({
      _tag: "BearerConnectionProfile",
      connectionId: value.environmentId,
      environmentId: value.environmentId,
      label: value.environmentId,
      httpBaseUrl: value.httpBaseUrl,
      wsBaseUrl: value.httpBaseUrl.replace("http", "ws"),
    })),
    credentials: [],
    remoteDpopTokens: [],
    disabledEnvironmentIds: [],
  });
  const win = new BrowserWindow({
    show: true,
    webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const check = async (expected, filename) => {
    NodeAssert.equal(await evaluate('document.querySelector("h1").textContent'), expected);
    NodeAssert.equal(await evaluate('localStorage.getItem("delivery-proof")'), "retained");
    NodeAssert.equal(await evaluate("typeof window.deliveryUi.select"), "function");
    const info = await evaluate("window.deliveryUi.info()");
    console.log(JSON.stringify({ expected, ...info, originStable: win.webContents.getURL() }));
    await evaluate(`{
      const info=${JSON.stringify(JSON.stringify(info))};
      const source=JSON.parse(info);
      const section=document.createElement("section");
      section.innerHTML="<h2>About</h2>";
      const entries={"UI version":document.querySelector("h1").textContent,"Shell version":source.shellVersion,"Server version":source.source==="server"?source.version:"Offline","UI source":source.origin??"Bundled copy"};
      const table=document.createElement("dl");
      for(const [label,value]of Object.entries(entries)){const key=document.createElement("dt");key.textContent=label;const field=document.createElement("dd");field.textContent=value;table.append(key,field);}
      section.append(table);if(source.reason){const reason=document.createElement("p");reason.textContent=source.reason;section.append(reason);}
      document.body.append(section);
      const style=document.createElement("style");style.textContent="body{font:18px system-ui;max-width:820px;margin:48px;color:#18202b;background:#f5f6fa}section{padding:28px;background:white;border:1px solid #d4dae4;border-radius:12px}dl{display:grid;grid-template-columns:180px 1fr;gap:16px}dt{font-weight:600}dd{margin:0}p{color:#5d6675}";document.head.append(style);
    }`);
    await NodeFSP.writeFile(
      NodePath.join(output, filename),
      (await win.webContents.capturePage()).toPNG(),
    );
    return info;
  };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Ui.DesktopUi;
          const protocolService = yield* EP.ElectronProtocol;
          yield* (yield* EW.ElectronWindow).setMain(win);
          const ipc = yield* Ipc.DesktopIpc;
          yield* ipc.handle(UiIpc.select);
          yield* ipc.handle(UiIpc.getInfo);
          const run = Effect.runPromiseWith(yield* Effect.context());
          yield* protocolService.registerDesktopProtocol({
            scheme: "t3code",
            assetDirectory: offline,
            clerkFrontendApiHostname: undefined,
            serverOrigin: () =>
              run(source.selection).then((value) =>
                value?.httpBaseUrl ? new URL(value.httpBaseUrl) : null,
              ),
            onSource: (origin, reason) => run(source.recordSource(origin, reason)),
          });
          yield* Effect.promise(async () => {
            await win.loadURL("t3code://app/");
            await evaluate('localStorage.setItem("delivery-proof","retained")');
            await check("D1 bundled offline", "desktop-initial-offline.png");
            NodeAssert.equal(
              await evaluate(`window.deliveryUi.select(${JSON.stringify(entries[0])})`),
              true,
            );
            await win.loadURL("t3code://app/");
            NodeAssert.equal(
              (await check("D1 studio UI1", "desktop-studio-v1.png")).version,
              studioVersion,
            );
            studioVersion = "D1 studio UI2";
            NodeAssert.equal(
              await evaluate(
                `window.deliveryUi.select(${JSON.stringify({ ...entries[0], serverVersion: studioVersion })})`,
              ),
              true,
            );
            await win.loadURL("t3code://app/");
            NodeAssert.equal(
              (await check(studioVersion, "desktop-studio-v2.png")).version,
              studioVersion,
            );
            NodeAssert.equal(
              await evaluate(`window.deliveryUi.select(${JSON.stringify(entries[1])})`),
              true,
            );
            await win.loadURL("t3code://app/");
            const switched = await check("D1 cloudbox UI1", "desktop-cloudbox.png");
            NodeAssert.equal(switched.environmentId, "cloudbox");
            NodeAssert.equal(switched.origin, cloudboxOrigin + "/");
            await new Promise((resolve) => cloudbox.close(resolve));
            await win.loadURL("t3code://app/");
            const fallback = await check("D1 bundled offline", "desktop-offline-fallback.png");
            NodeAssert.equal(fallback.source, "bundled");
            NodeAssert.equal(fallback.version, "D1 shell1");
            NodeAssert.match(fallback.reason, /unavailable/);
            const other = new BrowserWindow({
              show: false,
              webPreferences: { preload, contextIsolation: true, sandbox: true },
            });
            try {
              await other.loadURL("t3code://app/");
              const refusal = await other.webContents.executeJavaScript(
                `window.deliveryUi.select(${JSON.stringify(entries[0])}).then(()=>false,error=>error.message)`,
              );
              NodeAssert.match(refusal, /main application frame/);
              console.log("untrusted auxiliary frame refused");
            } finally {
              other.destroy();
            }
          });
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(Ui.layer, EP.layer, EW.layer, Ipc.layer(ipcMain)).pipe(
            Layer.provide(
              Layer.succeed(Environment.DesktopEnvironment, {
                stateDir: output,
                appVersion: "D1 shell1",
                isDevelopment: false,
              }),
            ),
            Layer.provide(
              Layer.succeed(Catalog.DesktopConnectionCatalogStore, {
                get: Effect.succeed(Option.some(catalog)),
                set: () => Effect.succeed(true),
              }),
            ),
            Layer.provide(
              Layer.succeed(Exposure.DesktopServerExposure, {
                backendConfig: Effect.succeed({
                  port: 0,
                  httpBaseUrl: new URL("http://127.0.0.1"),
                }),
              }),
            ),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
    console.log("desktop delivery source switching proof passed");
  } finally {
    win.destroy();
    studio.close();
    cloudbox.close();
    app.quit();
  }
}
main().catch((error) => {
  console.error(error);
  app.exit(1);
});
