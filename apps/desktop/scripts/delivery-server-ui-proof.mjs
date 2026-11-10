// Electron proof: packaged preload against a real `t3 serve` behind temporary HTTPS,
// showing server-UI pairing, restart recovery and bundled fallback. Only the temporary
// Electron profile trusts the self-signed certificate; no installed profile or live
// server is used.
import { app, BrowserWindow, ipcMain, net, protocol, session } from "electron";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { parseSemver } from "@t3tools/shared/semver";
import * as EP from "../src/electron/ElectronProtocol.ts";
import * as Ipc from "../src/ipc/DesktopIpc.ts";
import * as Channels from "../src/ipc/channels.ts";
import * as DesktopUi from "../src/app/DesktopUi.ts";
import * as DesktopEnvironment from "../src/app/DesktopEnvironment.ts";
import * as DesktopConnectionCatalogStore from "../src/app/DesktopConnectionCatalogStore.ts";
import * as DesktopServerExposure from "../src/backend/DesktopServerExposure.ts";
import * as DesktopLocalEnvironmentAuth from "../src/backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopSshEnvironment from "../src/ssh/DesktopSshEnvironment.ts";
import { isBundledUiUrl } from "../src/ipc/rendererTrust.ts";

const REPO = NodePath.resolve(import.meta.dirname, "../../..");
const output = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-ui-proof-"));
const OUT = process.env.T3_PROOF_SHOTS_DIR ?? NodePath.join(output, "shots");
app.setPath("userData", NodePath.join(output, "profile"));
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([
  { scheme: "t3code", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw new Error(`${label} timed out: ${last instanceof Error ? last.message : String(last)}`);
}

function serverEnvironment(home, binDir) {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    XDG_DATA_HOME: NodePath.join(home, ".local/share"),
    XDG_CACHE_HOME: NodePath.join(home, ".cache"),
    SSH_AUTH_SOCK: "",
    GIT_CONFIG_GLOBAL: NodePath.join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    T3_MESH_AGENT_HOME: home,
    T3_MESH_SSH_HOME: home,
    T3CODE_TELEMETRY_ENABLED: "false",
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
}

function runServerCli(baseDir, home, binDir, args) {
  const result = NodeChildProcess.spawnSync(
    process.env.T3_PROOF_NODE ?? "node",
    [NodePath.join(REPO, "apps/server/src/bin.ts"), ...args, "--base-dir", baseDir],
    { cwd: REPO, env: serverEnvironment(home, binDir), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function addProject(baseDir, projectDir, home, binDir) {
  runServerCli(baseDir, home, binDir, ["project", "add", projectDir]);
}

function mintToken(baseDir, home, binDir) {
  const token = runServerCli(baseDir, home, binDir, [
    "auth",
    "session",
    "issue",
    "--ttl",
    "12h",
    "--token-only",
  ])
    .trim()
    .split("\n")[0];
  if (typeof token !== "string" || token.length === 0)
    throw new Error("session issue returned no token");
  return token;
}

async function connectRpc(origin, token) {
  const response = await net.fetch(new URL("/api/auth/websocket-ticket", origin).toString(), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`websocket ticket failed (HTTP ${response.status})`);
  const { ticket } = await response.json();
  const socket = new WebSocket(
    `${origin.replace(/^http/, "ws").replace(/\/$/, "")}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=2&clientSurface=cli`,
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    for (const line of String(event.data).split("\n")) {
      if (!line) continue;
      const message = JSON.parse(line);
      if (message._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
      const request = pending.get(message.requestId);
      if (!request) continue;
      if (message._tag === "Exit") {
        pending.delete(message.requestId);
        clearTimeout(request.timer);
        if (message.exit._tag === "Success") request.resolve(message.exit.value);
        else request.reject(new Error(JSON.stringify(message.exit.cause)));
      }
    }
  });
  return (tag, payload = {}) =>
    new Promise((resolve, reject) => {
      const id = `proof-${++sequence}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC ${tag} timed out`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
}

function olderVersion(version) {
  const parsed = parseSemver(version);
  if (parsed === null) return null;
  if (parsed.patch > 0) return `${parsed.major}.${parsed.minor}.${parsed.patch - 1}`;
  if (parsed.minor > 0) return `${parsed.major}.${parsed.minor - 1}.0`;
  if (parsed.major > 0) return `${parsed.major - 1}.0.0`;
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function createCertificate(directory) {
  const key = NodePath.join(directory, "key.pem");
  const cert = NodePath.join(directory, "cert.pem");
  NodeChildProcess.execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { key: NodeFS.readFileSync(key), cert: NodeFS.readFileSync(cert) };
}

function ensureWebBuild() {
  const index = NodePath.join(REPO, "apps/web/dist/index.html");
  if (NodeFS.existsSync(index)) return;
  console.log("building apps/web/dist for the proof");
  NodeChildProcess.execFileSync(
    NodePath.join(REPO, "node_modules/.bin/vp"),
    ["run", "--filter", "@t3tools/web", "build"],
    { cwd: REPO, stdio: "inherit" },
  );
}

async function buildPreload() {
  const preload = NodePath.join(output, "preload.cjs");
  const require = NodeModule.createRequire(import.meta.url);
  const esbuild = require(
    NodeModule.createRequire(require.resolve("vite-plus/package.json")).resolve("esbuild"),
  );
  await esbuild.build({
    entryPoints: [NodePath.join(REPO, "apps/desktop/src/preload.ts")],
    outfile: preload,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  return preload;
}

function startServer(baseDir, port, binDir, home) {
  const child = NodeChildProcess.spawn(
    process.env.T3_PROOF_NODE ?? "node",
    [
      NodePath.join(REPO, "apps/server/src/bin.ts"),
      "serve",
      "--base-dir",
      baseDir,
      "--mode",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-browser",
    ],
    {
      cwd: REPO,
      env: serverEnvironment(home, binDir),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const state = { child, log: "", pairingToken: null, exited: false };
  const consume = (chunk) => {
    state.log += chunk.toString();
    const token = /Pairing URL: \S+#token=([^\s]+)/.exec(state.log);
    if (token) state.pairingToken = token[1];
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  child.once("exit", () => {
    state.exited = true;
  });
  return state;
}

let proofIframePost = null;

function createHttpsProxy({ key, cert }, httpPort, tlsPort) {
  const server = NodeHttps.createServer({ key, cert }, (request, response) => {
    if (request.method === "POST" && request.url?.startsWith("/api/w2-iframe-post")) {
      proofIframePost = {
        authorization: request.headers.authorization ?? null,
        cookie: request.headers.cookie ?? null,
        requestToken: request.headers["x-t3-server-ui"] ?? null,
        origin: request.headers.origin ?? null,
        secFetchSite: request.headers["sec-fetch-site"] ?? null,
      };
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("iframe post accepted");
      return;
    }
    const upstream = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: httpPort,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: `127.0.0.1:${httpPort}` },
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      },
    );
    upstream.once("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  server.on("upgrade", (request, socket, head) => {
    const upstream = NodeNet.connect(httpPort, "127.0.0.1", () => {
      const headers = Object.entries(request.headers)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`)
        .join("\r\n");
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.once("error", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(tlsPort, "127.0.0.1", () => resolve(server)));
}

process.on("unhandledRejection", (error) => console.error("unhandledRejection", error));
process.on("uncaughtException", (error) => console.error("uncaughtException", error));

async function main() {
  console.log("proof: start");
  ensureWebBuild();
  NodeFSP.mkdir(OUT, { recursive: true });
  await app.whenReady();
  console.log("proof: app ready");
  const defaultSession = session.defaultSession;
  const assets = NodePath.join(REPO, "apps/web/dist");
  const preload = await buildPreload();
  const httpPort = await freePort();
  const tlsPort = await freePort();
  const cloudboxPort = await freePort();
  const baseDir = NodePath.join(output, "server");
  const binDir = NodePath.join(output, "bin");
  const studioHome = NodePath.join(output, "studio-home");
  const cloudboxHome = NodePath.join(output, "cloudbox-home");
  const cloudboxBaseDir = NodePath.join(output, "cloudbox-server");
  const cloudboxBinDir = NodePath.join(output, "cloudbox-bin");
  await NodeFSP.mkdir(binDir, { recursive: true });
  await NodeFSP.mkdir(cloudboxBinDir, { recursive: true });
  await NodeFSP.mkdir(studioHome, { recursive: true });
  await NodeFSP.mkdir(cloudboxHome, { recursive: true });
  const hostnamectl = NodePath.join(binDir, "hostnamectl");
  await NodeFSP.writeFile(hostnamectl, "#!/bin/sh\nprintf 'studio\\n'\n", { mode: 0o755 });
  await NodeFSP.writeFile(
    NodePath.join(cloudboxBinDir, "hostnamectl"),
    "#!/bin/sh\nprintf 'cloudbox\\n'\n",
    { mode: 0o755 },
  );
  const projectDir = NodePath.join(output, "studio-project");
  await NodeFSP.mkdir(projectDir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(projectDir, "README.md"), "# studio-project\n");
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: projectDir });
  const cloudboxProjectDir = NodePath.join(output, "cloudbox-project");
  await NodeFSP.mkdir(cloudboxProjectDir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(cloudboxProjectDir, "README.md"), "# cloudbox-project\n");
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: cloudboxProjectDir });
  addProject(baseDir, projectDir, studioHome, binDir);
  addProject(cloudboxBaseDir, cloudboxProjectDir, cloudboxHome, cloudboxBinDir);
  await NodeFSP.writeFile(
    NodePath.join(assets, "w2-preview.html"),
    '<!doctype html><meta charset="utf-8"><title>HTML preview</title><body style="margin:0;font:15px system-ui,sans-serif;background:#faf9f7;color:#222"><main style="padding:24px"><h1 style="margin:0 0 8px;font-size:20px">HTML preview</h1><p style="margin:0;color:#666">Served by this machine and rendered inside the server UI.</p><p style="margin:16px 0 0;padding:12px 14px;border:1px solid #ddd;border-radius:10px;background:#fff">If you can read this, the preview surface is working.</p><script>fetch("/api/w2-iframe-post", { method: "POST", body: "side effect" }).catch(() => {})</script></main></body>',
  );
  const certificate = createCertificate(output);
  const certificatePem = NodeFS.readFileSync(NodePath.join(output, "cert.pem"), "utf8").replace(
    /\s+/g,
    "",
  );
  // Trust only this proof's certificate and only for its loopback host.
  const verifyCertificate = (request, callback) => {
    const hostAllowed = request.hostname === "127.0.0.1" || request.hostname === "localhost";
    const sameCertificate = request.certificate.data.replace(/\s+/g, "") === certificatePem;
    callback(hostAllowed && sameCertificate ? 0 : -2);
  };
  await defaultSession.setCertificateVerifyProc(verifyCertificate);
  const origin = new URL(`https://127.0.0.1:${tlsPort}/`);
  // The desktop catalog uses the TLS proxy, but the servers' own RPC and mesh links
  // speak their loopback HTTP origins.
  const studioHttpOrigin = new URL(`http://127.0.0.1:${httpPort}/`);
  let serverOriginUrl = origin;
  const proxy = await createHttpsProxy(certificate, httpPort, tlsPort);

  let server = startServer(baseDir, httpPort, binDir, studioHome);
  try {
    await waitFor("server ready", () => !server.exited && server.pairingToken !== null, 60_000);
  } catch (error) {
    console.error(server.log);
    throw error;
  }
  let cloudboxServer = startServer(cloudboxBaseDir, cloudboxPort, cloudboxBinDir, cloudboxHome);
  try {
    await waitFor(
      "cloudbox server ready",
      () => !cloudboxServer.exited && cloudboxServer.pairingToken !== null,
      60_000,
    );
  } catch (error) {
    console.error(cloudboxServer.log);
    throw error;
  }
  console.log("proof: servers ready");
  const cloudboxOrigin = new URL(`http://127.0.0.1:${cloudboxPort}/`);
  const studioToken = mintToken(baseDir, studioHome, binDir);
  const cloudboxToken = mintToken(cloudboxBaseDir, cloudboxHome, cloudboxBinDir);
  const studioDescriptorResponse = await net.fetch(
    new URL("/.well-known/t3/environment", studioHttpOrigin).toString(),
  );
  if (!studioDescriptorResponse.ok) throw new Error("studio environment descriptor failed");
  const studioDescriptor = await studioDescriptorResponse.json();
  const cloudboxDescriptorResponse = await net.fetch(
    new URL("/.well-known/t3/environment", cloudboxOrigin).toString(),
  );
  if (!cloudboxDescriptorResponse.ok) throw new Error("cloudbox environment descriptor failed");
  const cloudboxDescriptor = await cloudboxDescriptorResponse.json();
  const studioRpc = await connectRpc(studioHttpOrigin.href, studioToken);
  const cloudboxRpc = await connectRpc(cloudboxOrigin.href, cloudboxToken);
  await studioRpc("server.updateSettings", {
    patch: { meshEnabled: true, linkedEnvironmentsEnabled: true },
  });
  await cloudboxRpc("server.updateSettings", {
    patch: { meshEnabled: true, linkedEnvironmentsEnabled: true },
  });
  const pairingCode = JSON.parse(
    runServerCli(cloudboxBaseDir, cloudboxHome, cloudboxBinDir, [
      "auth",
      "pairing",
      "create",
      "--ttl",
      "20m",
      "--json",
    ]),
  );
  await studioRpc("peerLinks.link", {
    url: cloudboxOrigin.href,
    pairingCode: pairingCode.credential,
    access: "full-access",
  });
  console.log("proof: mesh linked");
  await waitFor(
    "mesh config on studio names both machines",
    async () => {
      const value = await studioRpc("meshConfig.get", {});
      return Object.keys(value.current.doc.machines ?? {}).length === 2 ? value : null;
    },
    60_000,
  );

  let selectCalls = [];
  let serverName = "Studio";
  let serverUiCredentialOverride = null;
  let rejected = [];
  let serverUiPageUrl = null;
  let useRealUi = true;
  let activeUi = null;
  let catalog = {
    schemaVersion: 1,
    targets: [
      {
        _tag: "BearerConnectionTarget",
        connectionId: "studio",
        environmentId: studioDescriptor.environmentId,
        label: studioDescriptor.label,
      },
      {
        _tag: "BearerConnectionTarget",
        connectionId: "cloudbox",
        environmentId: cloudboxDescriptor.environmentId,
        label: cloudboxDescriptor.label,
      },
      {
        _tag: "BearerConnectionTarget",
        connectionId: "joseph",
        environmentId: "joseph",
        label: "joseph",
      },
    ],
    profiles: [
      {
        _tag: "BearerConnectionProfile",
        connectionId: "studio",
        environmentId: studioDescriptor.environmentId,
        label: studioDescriptor.label,
        httpBaseUrl: origin.href,
        wsBaseUrl: origin.href.replace(/^https/, "wss"),
      },
      {
        _tag: "BearerConnectionProfile",
        connectionId: "cloudbox",
        environmentId: cloudboxDescriptor.environmentId,
        label: cloudboxDescriptor.label,
        httpBaseUrl: cloudboxOrigin.href,
        wsBaseUrl: cloudboxOrigin.href.replace(/^http/, "ws"),
      },
      {
        _tag: "BearerConnectionProfile",
        connectionId: "joseph",
        environmentId: "joseph",
        label: "joseph",
        httpBaseUrl: "http://127.0.0.1:3775/",
        wsBaseUrl: "ws://127.0.0.1:3775/",
      },
    ],
    credentials: [
      {
        connectionId: "studio",
        credential: { _tag: "BearerConnectionCredential", token: studioToken },
      },
      {
        connectionId: "cloudbox",
        credential: { _tag: "BearerConnectionCredential", token: cloudboxToken },
      },
      {
        connectionId: "joseph",
        credential: { _tag: "BearerConnectionCredential", token: "disabled-token" },
      },
    ],
    remoteDpopTokens: [],
    // The live Windows desktop keeps one saved connection toggled off.
    disabledEnvironmentIds: ["joseph"],
  };
  const info = {
    source: "server",
    origin: origin.href,
    environmentId: null,
    version: "1",
    shellVersion: "1",
    reason: null,
  };
  console.log("proof: window");
  const window = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source, true);
  window.webContents.on("did-fail-load", (_event, code, description, url) =>
    console.error("did-fail-load", code, description, url),
  );
  window.webContents.on("render-process-gone", (_event, details) =>
    console.error("render-process-gone", details),
  );
  const screenshot = async (name) => {
    const image = await window.webContents.capturePage();
    await NodeFSP.writeFile(NodePath.join(OUT, name), image.toPNG());
  };
  const loadServerUi = async (token) => {
    if (serverUiPageUrl === null) {
      await window.loadURL(`t3code://app/?desktopWindowId=${window.webContents.id}`);
      serverUiPageUrl = window.webContents.getURL();
    }
    if (!token) {
      await window.loadURL(serverUiPageUrl);
      return;
    }
    const url = new URL(serverUiPageUrl);
    url.searchParams.set("t", String(Date.now()));
    url.hash = `token=${encodeURIComponent(token)}`;
    await window.loadURL(url.toString());
  };
  const sessionState = () =>
    evaluate(
      `fetch("/api/auth/session", { cache: "no-store", headers: { "x-t3-server-ui": window.desktopShell?.requestToken ?? "" } }).then((r) => r.json()).then((v) => v.authenticated === true).catch(() => false)`,
    );
  const bodyText = () => evaluate("document.body.innerText");
  const appShell = async () => {
    if (!(await sessionState())) return false;
    const text = await bodyText();
    return !text.includes("Pair with this environment") && text.trim().length > 20;
  };
  const clickButton = (labels) =>
    evaluate(`(() => {
      const labels = ${JSON.stringify(labels)};
      const button = [...document.querySelectorAll("button")].find(
        (entry) => labels.includes(entry.textContent?.trim()) && !entry.disabled,
      );
      if (!button) return false;
      button.click();
      return true;
    })()`);
  const waitForStableShell = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await appShell()) {
        await sleep(1_000);
        if (await appShell()) return;
      }
      await sleep(300);
    }
    throw new Error("app shell did not settle");
  };
  const finishOnboarding = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const text = await bodyText();
      if (!/Connect your (computers|agents)|Import your projects|Your projects/.test(text)) return;
      if (!(await clickButton(["Continue", "Do not import projects", "Skip"]))) return;
      await sleep(700);
    }
  };
  const bundledAppShell = async () => {
    if (window.webContents.getURL().startsWith("t3code://server-")) return false;
    const text = await bodyText();
    return (
      !text.includes("Can't reach") &&
      !text.includes("T3 Code failed to start") &&
      !text.includes("Pair with this environment") &&
      text.trim().length > 20
    );
  };
  const waitForStableBundled = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await bundledAppShell()) {
        await sleep(1_000);
        if (await bundledAppShell()) return;
      }
      await sleep(300);
    }
    throw new Error("bundled app shell did not settle");
  };

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ipc = Ipc.make(ipcMain, () => {});
          const sync = (channel, handler) =>
            ipc.handleSync({ channel, handler: () => Effect.succeed(handler()) });
          const proofUi = (stateDir, appVersion) =>
            DesktopUi.make.pipe(
              Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
                stateDir,
                appVersion,
                isDevelopment: false,
              }),
              Effect.provideService(
                DesktopConnectionCatalogStore.DesktopConnectionCatalogStore,
                DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.of({
                  get: Effect.sync(() => Option.some(JSON.stringify(catalog))),
                  set: () => Effect.succeed(true),
                }),
              ),
              Effect.provideService(DesktopServerExposure.DesktopServerExposure, {
                backendConfig: Effect.succeed({
                  port: 0,
                  httpBaseUrl: new URL("http://127.0.0.1"),
                }),
              }),
              Effect.provideService(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
                getBearerToken: Effect.fail(
                  new DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuthBackendNotConfiguredError(),
                ),
              }),
              Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
                activeEnvironments: Effect.succeed([]),
              }),
            );
          const equalUi = yield* proofUi(
            NodePath.join(output, "ui-equal"),
            studioDescriptor.serverVersion,
          );
          const olderStudioVersion = olderVersion(studioDescriptor.serverVersion);
          NodeAssert.ok(olderStudioVersion, "studio server version is semantic");
          const newerUi = yield* proofUi(NodePath.join(output, "ui-newer"), olderStudioVersion);
          activeUi = equalUi;
          yield* sync(Channels.UI_SERVER_ORIGIN_CHANNEL, () =>
            useRealUi ? (serverOriginUrl?.href ?? "") : serverOriginUrl.href,
          );
          yield* sync(Channels.UI_SERVER_NAME_CHANNEL, () => serverName);
          yield* sync(Channels.GET_APP_BRANDING_CHANNEL, () => null);
          yield* sync(Channels.GET_SYSTEM_LOCALE_CHANNEL, () => null);
          yield* sync(Channels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL, () => false);
          yield* sync(Channels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL, () => []);
          yield* sync(Channels.TAKE_LEGACY_LOCAL_STORAGE_CHANNEL, () => null);
          yield* sync(Channels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL, () => false);
          yield* ipc.handle({
            channel: Channels.UI_SELECT_CHANNEL,
            handler: (selection, event) => {
              selectCalls.push(selection);
              if (!useRealUi) {
                info.environmentId = selection?.environmentId ?? info.environmentId;
                return Effect.succeed(false);
              }
              const trusted =
                event?.senderFrame?.url !== undefined && isBundledUiUrl(event.senderFrame.url);
              return activeUi.select(selection, { trustedClient: trusted });
            },
          });
          yield* ipc.handle({
            channel: Channels.UI_INFO_CHANNEL,
            handler: () => (useRealUi ? activeUi.getInfo : Effect.succeed(info)),
          });
          yield* ipc.handle({
            channel: Channels.REVEAL_WINDOW_CHANNEL,
            handler: () => Effect.void,
          });
          yield* sync(Channels.GET_RELAY_TELEMETRY_ENABLED_CHANNEL, () => false);
          yield* ipc.handle({
            channel: Channels.GET_CONNECTION_CATALOG_CHANNEL,
            handler: () => Effect.succeed(JSON.stringify(catalog)),
          });
          yield* ipc.handle({
            channel: Channels.SET_CONNECTION_CATALOG_CHANNEL,
            handler: (value) =>
              Effect.sync(() => {
                if (typeof value === "string") {
                  try {
                    catalog = JSON.parse(value);
                  } catch {
                    // Keep the last valid catalog.
                  }
                }
                return true;
              }),
          });
          yield* sync(Channels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL, () => null);
          for (const channel of [
            Channels.SET_THEME_CHANNEL,
            Channels.GET_CLIENT_SETTINGS_CHANNEL,
            Channels.SET_CLIENT_SETTINGS_CHANNEL,
            Channels.SET_NOTIFICATION_BADGE_CHANNEL,
            Channels.UPDATE_GET_STATE_CHANNEL,
            Channels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL,
            Channels.PREVIEW_SET_FORWARDED_SHORTCUTS_CHANNEL,
            Channels.WEB_LINK_READY_CHANNEL,
          ]) {
            yield* ipc.handle({ channel, handler: () => Effect.succeed(null) });
          }
          yield* ipc.handle({
            channel: Channels.PROBE_REMOTE_EDITORS_CHANNEL,
            handler: () => Effect.succeed([]),
          });

          const protocolService = yield* EP.ElectronProtocol;
          yield* ipc.handleSync({
            channel: Channels.UI_REQUEST_TOKEN_CHANNEL,
            handler: (event) => {
              if (!event) return Effect.succeed(null);
              let host = "";
              try {
                host = new URL(event.senderFrame?.url ?? "").host;
              } catch {
                return Effect.succeed(null);
              }
              return protocolService.serverUiRequestTokenFor(host);
            },
          });
          yield* protocolService.trackWindow(window.webContents);
          yield* protocolService.registerDesktopProtocol({
            scheme: "t3code",
            assetDirectory: assets,
            sourceSalt: "proof-salt",
            serverOrigin: async () =>
              useRealUi ? await Effect.runPromise(activeUi.sourceOrigin) : serverOriginUrl,
            serverName: async () => {
              if (!useRealUi) return serverName;
              return (await Effect.runPromise(activeUi.selectionLabel)) ?? serverName;
            },
            serverAuthorization: async (origin) => {
              if (serverUiCredentialOverride !== null) return serverUiCredentialOverride;
              if (useRealUi) return await Effect.runPromise(activeUi.serverAuthorization(origin));
              const target = origin.href.replace(/\/$/, "");
              const profile = catalog.profiles.find(
                (entry) =>
                  entry._tag === "BearerConnectionProfile" &&
                  entry.httpBaseUrl.replace(/\/$/, "") === target,
              );
              if (!profile) return null;
              const credential = catalog.credentials.find(
                (entry) => entry.connectionId === profile.connectionId,
              );
              return credential === undefined
                ? null
                : {
                    authorization: credential.credential.token,
                    environmentId: profile.environmentId,
                  };
            },
            noteAuthorizationRejected: async (origin, token) => {
              if (useRealUi) {
                await Effect.runPromise(activeUi.noteAuthorizationRejected(origin, token));
                return;
              }
              rejected.push(token);
            },
            connectionOrigins: async () =>
              useRealUi
                ? await Effect.runPromise(activeUi.connectionOrigins).catch(() => [])
                : [serverOriginUrl.origin],
            onSource: async (source, reason) => {
              if (useRealUi) await Effect.runPromise(activeUi.recordSource(source, reason));
            },
            clerkFrontendApiHostname: undefined,
          });

          yield* Effect.promise(async () => {
            console.log("proof: phase equal start");
            // (a) Equal versions keep the bundled client and its saved connections.
            useRealUi = true;
            activeUi = equalUi;
            selectCalls = [];
            serverUiPageUrl = null;
            await window.loadURL(`t3code://app/?desktopWindowId=${window.webContents.id}`);
            await waitForStableBundled();
            await waitFor(
              "both saved machines connect in the bundled client",
              async () => {
                const text = await bodyText();
                return text.includes("studio-project") && text.includes("cloudbox-project");
              },
              60_000,
            );
            NodeAssert.ok(
              !window.webContents.getURL().startsWith("t3code://server-"),
              "an equal server version keeps the bundled client",
            );
            const lastSelect = selectCalls.at(-1);
            NodeAssert.ok(lastSelect !== undefined, "the bundled client selected a source");
            NodeAssert.equal(
              lastSelect.httpBaseUrl,
              null,
              "an equal server version selects the bundled source",
            );
            await screenshot("07-equal-bundled.png");
            console.log(
              JSON.stringify({
                phase: "equal-versions",
                source: "bundled",
                machines: ["studio", "cloudbox"],
              }),
            );

            console.log("proof: phase local-off start");
            // Local environment off, one saved connection toggled off, two connected:
            // the live Windows desktop. A stale bundled flag with no direct source must
            // render the normal bundled app, not the offline page, before and after
            // Settings.
            await window.loadURL(
              `t3code://app/?desktopWindowId=${window.webContents.id}&bundled=1#/settings/connections`,
            );
            await waitFor(
              "bundled connections settings",
              async () => (await bodyText()).includes("Connections"),
              60_000,
            );
            await window.loadURL(
              `t3code://app/?desktopWindowId=${window.webContents.id}&bundled=1#/`,
            );
            await waitForStableBundled();
            NodeAssert.ok(!(await bodyText()).includes("Can't reach"));
            await waitFor(
              "projects after leaving settings",
              async () => (await bodyText()).includes("studio-project"),
              30_000,
            );
            await screenshot("08-local-off-bundled.png");
            console.log(
              JSON.stringify({
                phase: "local-off-bundled",
                source: "bundled",
                offlinePage: false,
              }),
            );

            console.log("proof: phase newer start");
            // (b) A newer server UI is used, and the mesh shows the second machine.
            useRealUi = true;
            activeUi = newerUi;
            selectCalls = [];
            await Effect.runPromise(
              newerUi.select({
                environmentId: studioDescriptor.environmentId,
                httpBaseUrl: origin.href,
                serverVersion: studioDescriptor.serverVersion,
              }),
            );
            serverUiPageUrl = null;
            await loadServerUi(null);
            await waitFor("server UI authenticated for a newer server", appShell, 60_000);
            await finishOnboarding();
            await waitForStableShell();
            await waitFor(
              "studio project in the server UI",
              async () => (await bodyText()).includes("studio-project"),
              60_000,
            );
            const newerInfo = await evaluate("window.desktopShell.ui.getInfo()");
            NodeAssert.equal(newerInfo.source, "server");
            NodeAssert.equal(newerInfo.environmentId, studioDescriptor.environmentId);
            NodeAssert.ok(
              !(await bodyText()).includes("Connect to all machines in your mesh"),
              "the reduced server UI does not offer the connect-all prompt",
            );
            NodeAssert.equal(
              await evaluate("document.querySelector('[data-mesh-connect-prompt]') === null"),
              true,
            );
            await waitFor(
              "mesh footer names both machines",
              async () => {
                const text = await bodyText();
                return text.includes("Mesh · 2 machines") && text.includes("synced");
              },
              30_000,
            );
            await waitFor(
              "new-thread machine cards",
              () => evaluate("document.querySelector('[data-draft-machine-cards]') !== null"),
              30_000,
            );
            await waitFor(
              "cloudbox card is available through the mesh",
              async () => {
                const text = await evaluate(
                  "document.querySelector('[data-draft-machine-cards]')?.innerText ?? ''",
                );
                return text.includes("Available through");
              },
              30_000,
            );
            const cardsText = await evaluate(
              "document.querySelector('[data-draft-machine-cards]')?.innerText ?? ''",
            );
            NodeAssert.ok(
              cardsText.includes("Available through studio"),
              `the cloudbox card names the mesh path, got: ${cardsText}`,
            );
            NodeAssert.ok(
              !cardsText.includes("Not connected here"),
              `a reachable machine is not called not connected, got: ${cardsText}`,
            );
            await screenshot("09-newer-server-ui-mesh.png");
            console.log(
              JSON.stringify({
                phase: "newer-server-ui",
                source: "server",
                machines: ["studio", "cloudbox"],
                connectAllPrompt: false,
              }),
            );

            // Legacy server-UI proof phases below use the manual shell bridge so their
            // rejection and restart knobs stay independent of the shared service.
            useRealUi = false;
            serverOriginUrl = origin;
            serverUiCredentialOverride = null;
            rejected = [];
            serverUiPageUrl = null;

            console.log("proof: phase legacy start");
            // (a) Pairing in server UI mode reaches an authenticated session and the shell.
            const token = server.pairingToken;
            NodeAssert.ok(token, "server pairing token");
            await loadServerUi(token);
            await waitFor("server UI authenticated", appShell, 60_000);
            await finishOnboarding();
            await waitForStableShell();
            await waitFor(
              "server UI WebSocket ticket",
              () =>
                evaluate(
                  `fetch("/api/auth/websocket-ticket/rpc", { method: "POST", headers: { "x-t3-server-ui": window.desktopShell?.requestToken ?? "" } }).then((r) => r.ok).catch(() => false)`,
                ),
              20_000,
            );
            const pairedText = await bodyText();
            NodeAssert.ok(!pairedText.includes("Timed out waiting"));
            NodeAssert.ok(!pairedText.includes("Pair with this environment"));
            await screenshot("01-paired-app-shell.png");
            console.log(JSON.stringify({ phase: "pairing", authenticated: true }));

            // (a2) A media ticket minted through the proxy opens a preview-stream socket,
            // and an HTML page served by the machine renders inside the server UI.
            await evaluate(`(async () => {
              const requestHeaders = { "x-t3-server-ui": window.desktopShell?.requestToken ?? "" };
              const ticket = await (await fetch("/api/auth/websocket-ticket/media", { method: "POST", headers: requestHeaders })).json();
              const origin = new URL(window.desktopShell.origin);
              origin.protocol = "wss:";
              origin.pathname = "/api/preview-stream/ws";
              origin.search = new URLSearchParams({ threadId: "proof", tabId: "proof", wsTicket: ticket.ticket }).toString();
              window.__w2media = await new Promise((resolve) => {
                const socket = new WebSocket(origin);
                const timer = setTimeout(() => resolve("timeout"), 5000);
                socket.onopen = () => { clearTimeout(timer); socket.close(); resolve("open"); };
                socket.onerror = () => { clearTimeout(timer); resolve("error"); };
              });
              const card = document.createElement("div");
              card.id = "w2-preview-card";
              card.style.cssText = "position:fixed;inset:auto 40px 40px auto;width:420px;height:260px;background:#fff;border:1px solid #3a3a3a;border-radius:12px;overflow:hidden;z-index:50;box-shadow:0 18px 60px rgba(0,0,0,.45)";
              const bar = document.createElement("div");
              bar.textContent = "HTML preview";
              bar.style.cssText = "padding:8px 12px;background:#1d1d1d;color:#ddd;font:12px system-ui,sans-serif";
              const frame = document.createElement("iframe");
              frame.id = "w2-preview-frame";
              frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
              frame.src = "/w2-preview.html";
              frame.style.cssText = "width:100%;height:calc(100% - 30px);border:0";
              card.append(bar, frame);
              document.body.append(card);
              return true;
            })()`);
            await waitFor(
              "media ticket opens a preview socket",
              async () => (await evaluate("window.__w2media")) === "open",
              15_000,
            );
            await waitFor(
              "HTML preview renders",
              () =>
                evaluate(
                  `document.getElementById("w2-preview-frame")?.contentDocument?.body?.innerText?.includes("HTML preview") === true`,
                ),
              20_000,
            );
            await waitFor("iframe preview POST arrived", () => proofIframePost !== null, 20_000);
            NodeAssert.equal(proofIframePost?.authorization, null);
            NodeAssert.equal(proofIframePost?.cookie, null);
            await sleep(400);
            await screenshot("02-html-preview.png");
            await evaluate(
              `document.getElementById("w2-preview-card")?.remove(); delete window.__w2media; true`,
            );
            console.log(JSON.stringify({ phase: "preview", mediaSocket: "open" }));

            // (b) A chunk failure during a restart waits for the server and reloads.
            server.child.kill("SIGTERM");
            await waitFor("server stopped", () => server.exited, 20_000);
            await evaluate(
              `setTimeout(() => { void import("/assets/definitely-missing-chunk.js"); }, 0); true`,
            );
            await waitFor(
              "reconnecting surface",
              async () => (await bodyText()).includes("Reconnecting to Studio"),
              30_000,
            );
            await screenshot("03-reconnecting.png");

            server = startServer(baseDir, httpPort, binDir, studioHome);
            await waitFor(
              "server restarted",
              () => !server.exited && server.pairingToken !== null,
              60_000,
            );
            await window.webContents.reload();
            await waitForStableShell();
            await screenshot("04-recovered-app-shell.png");
            console.log(JSON.stringify({ phase: "restart", recovered: true }));

            // (c) Reloading while the server is down falls back to the bundled client.
            server.child.kill("SIGTERM");
            await waitFor("server stopped again", () => server.exited, 20_000);
            await window.webContents.reload();
            await waitFor(
              "bundled fallback while the server is down",
              async () => {
                const url = window.webContents.getURL();
                if (!url.includes("bundled=1")) return false;
                const text = await bodyText();
                return text.includes("Can't reach") && !text.includes("T3 Code failed to start");
              },
              60_000,
            );
            await sleep(500);
            await screenshot("05-offline-fallback.png");

            server = startServer(baseDir, httpPort, binDir, studioHome);
            await waitFor(
              "server restarted for the auth check",
              () => !server.exited && server.pairingToken !== null,
              60_000,
            );

            // (d) A credential the server rejects sends the window to the bundled client,
            // which connects with the saved bearer connection and shows this server's project.
            console.log(JSON.stringify({ phase: "auth-impossible-start" }));
            // Simulate a stale shell credential while the saved connection keeps working.
            serverUiCredentialOverride = null;
            serverOriginUrl = new URL(`https://localhost:${tlsPort}/`);
            serverUiPageUrl = null;
            rejected = [];
            const bearerToken = mintToken(baseDir, studioHome, binDir);
            console.log(JSON.stringify({ phase: "bearer", length: bearerToken.length }));
            const descriptorResponse = await net.fetch(
              new URL("/.well-known/t3/environment", serverOriginUrl).toString(),
            );
            if (!descriptorResponse.ok) throw new Error("environment descriptor failed");
            const descriptor = await descriptorResponse.json();
            serverUiCredentialOverride = {
              authorization: "rejected-token",
              environmentId: descriptor.environmentId,
            };
            const connectionId = "desktop-server";
            catalog = {
              schemaVersion: 1,
              targets: [
                {
                  _tag: "BearerConnectionTarget",
                  connectionId,
                  environmentId: descriptor.environmentId,
                  label: descriptor.label,
                },
              ],
              profiles: [
                {
                  _tag: "BearerConnectionProfile",
                  connectionId,
                  environmentId: descriptor.environmentId,
                  label: descriptor.label,
                  httpBaseUrl: serverOriginUrl.href,
                  wsBaseUrl: serverOriginUrl.href.replace(/^https/, "wss"),
                },
              ],
              credentials: [
                {
                  connectionId,
                  credential: { _tag: "BearerConnectionCredential", token: bearerToken },
                },
              ],
              remoteDpopTokens: [],
              disabledEnvironmentIds: [],
            };
            console.log(JSON.stringify({ phase: "auth-impossible-load" }));
            await loadServerUi(null).catch((error) =>
              console.error("phase-c loadURL rejected", error),
            );
            console.log(
              JSON.stringify({ phase: "auth-impossible-loaded", url: window.webContents.getURL() }),
            );
            await waitFor(
              "bundled fallback after rejected credential",
              async () => {
                if (!window.webContents.getURL().includes("bundled=1")) return false;
                if (!rejected.includes("rejected-token")) return false;
                return (await bodyText()).includes("studio-project");
              },
              90_000,
            );
            await sleep(1_000);
            const fallbackText = await bodyText();
            NodeAssert.ok(fallbackText.includes("studio-project"), "bundled app shows the project");
            NodeAssert.ok(!fallbackText.includes("Can't reach"), "bundled app is connected");
            NodeAssert.ok(!fallbackText.includes("T3 Code failed to start"));
            await screenshot("06-auth-impossible-bundled.png");
            console.log(JSON.stringify({ phase: "auth-impossible", bundled: true, project: true }));
          });
        }).pipe(Effect.provide(EP.layer), Effect.provide(NodeServices.layer)),
      ),
    );

    await NodeFSP.writeFile(
      NodePath.join(OUT, "INDEX.md"),
      [
        "# W3 desktop server UI proof",
        "",
        "| Shot | State |",
        "| --- | --- |",
        "| 07-equal-bundled.png | Equal client and server versions keep the bundled client; both saved machines (studio and cloudbox) are connected and their projects show |",
        "| 08-local-off-bundled.png | Local environment off, one saved connection toggled off, two connected: the stale bundled flag after Settings renders the normal bundled app, not the offline page |",
        "| 09-newer-server-ui-mesh.png | The server UI is newer, so the desktop uses it; its new-thread cards say cloudbox is available through the mesh (studio), never 'Not connected here', and there is no connect-all prompt |",
        "| 01-paired-app-shell.png | Server UI paired through the shell proxy; app shell rendered |",
        "| 02-html-preview.png | A media ticket opens a preview socket; an HTML preview iframe renders in server UI and its POST reaches the proxy with no Authorization or cookie |",
        "| 03-reconnecting.png | Chunk load failed during a server restart; a calm reconnecting overlay appears without touching the mounted app |",
        "| 04-recovered-app-shell.png | Server restarted; the page reloaded and the server UI shell renders again |",
        "| 05-offline-fallback.png | Reload while the server is down falls back to the bundled client's offline page |",
        "| 06-auth-impossible-bundled.png | Server rejected the shell credential; the bundled client connected with its saved bearer and shows studio-project |",
        "",
      ].join("\n"),
    );
    console.log(JSON.stringify({ output, shots: OUT }));
  } finally {
    if (!server.exited) server.child.kill("SIGTERM");
    if (!cloudboxServer.exited) cloudboxServer.child.kill("SIGTERM");
    window.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  }
}

void main().then(
  () => app.quit(),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
