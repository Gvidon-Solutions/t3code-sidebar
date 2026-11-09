// @effect-diagnostics-next-line nodeBuiltinImport:off -- Source-specific renderer origins are computed before document navigation.
import * as NodeCrypto from "node:crypto";
import { serverUiRendererId } from "../ipc/rendererTrust.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Mime from "effect/http/Mime";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export const DESKTOP_HOST = "app";
function sourceHost(id: number, origin: URL): string {
  return `server-${id}-${NodeCrypto.createHash("sha256").update(origin.href).digest("hex").slice(0, 24)}`;
}
const DESKTOP_PRODUCTION_SCHEME = "t3code";
const DESKTOP_DEVELOPMENT_SCHEME = "t3code-dev";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}

export class ElectronProtocolRegistrationError extends Schema.TaggedError<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class ElectronProtocolUnregistrationError extends Schema.TaggedError<ElectronProtocolUnregistrationError>()(
  "ElectronProtocolUnregistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

export type DesktopProtocolRegistrationInput = {
  readonly scheme: string;
  readonly clerkFrontendApiHostname: string | undefined;
  readonly connectionOrigins?: () => Promise<ReadonlyArray<string>>;
} & (
  | { readonly targetOrigin: URL }
  | {
      readonly assetDirectory: string;
      readonly serverOrigin?: () => Promise<URL | null>;
      readonly serverName?: () => Promise<string | null>;
      readonly onSource?: (origin: URL | null, reason?: string) => Promise<void>;
    }
);

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly serverOriginFor: (rendererId: number) => Effect.Effect<string | null>;
    readonly trackWindow: (contents: Electron.WebContents) => Effect.Effect<void>;
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronProtocol") {}

function makeDesktopContentSecurityPolicy(
  input: DesktopProtocolRegistrationInput,
  origins?: ReadonlyArray<string>,
): string {
  const clerkOrigin = input.clerkFrontendApiHostname
    ? `https://${input.clerkFrontendApiHostname}`
    : undefined;
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    "'wasm-unsafe-eval'",
    ...(clerkOrigin ? [clerkOrigin] : []),
    "https://challenges.cloudflare.com",
  ];

  // User-configured environment origins are unknown here, so allow supported network schemes.
  // GLTFLoader fetches embedded textures through blob URLs.
  const connectSources =
    origins === undefined
      ? ["'self'", "blob:", "http:", "https:", "ws:", "wss:"]
      : [
          "'self'",
          ...origins.flatMap((value) => {
            const url = new URL(value);
            return [url.origin, url.origin.replace(/^http/, "ws")];
          }),
        ];

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `img-src 'self' ${input.scheme}: blob: data: http: https:`,
    `media-src 'self' ${input.scheme}: blob: http: https:`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' ${input.scheme}: data:`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob: http: https:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Must run synchronously before Electron emits ready.
function registerDesktopSchemePrivilegesSync(): void {
  Electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_PRODUCTION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        // Custom schemes must opt into V8 caching; dev URLs serve changing code.
        codeCache: true,
      },
    },
    {
      scheme: DESKTOP_DEVELOPMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

const registerDesktopSchemePrivileges = Effect.sync(registerDesktopSchemePrivilegesSync).pipe(
  Effect.withSpan("desktop.electron.protocol.registerSchemePrivileges"),
);

export const layerSchemePrivileges = Layer.effectDiscard(registerDesktopSchemePrivileges);

class ElectronProtocolFetchError extends Schema.TaggedError<ElectronProtocolFetchError>()(
  "ElectronProtocolFetchError",
  { cause: Schema.Defect() },
) {}

const netFetch = (url: string, init: RequestInit) =>
  Effect.tryPromise({
    try: () => Electron.net.fetch(url, init),
    catch: (cause) => new ElectronProtocolFetchError({ cause }),
  });

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Dev-only shell fallback when the Vite target server is down (production serves bundled assets). */
export function offlineShellResponse(targetOrigin: URL): Response {
  const address = escapeHtml(targetOrigin.host || targetOrigin.href);
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Can't reach the server</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#eee;font:15px system-ui,sans-serif"><main style="text-align:center;padding:24px;max-width:420px"><h1 style="font-size:20px;font-weight:600">Can't reach the server</h1><p style="color:#aaa;line-height:1.6">T3 Code can't reach the server. Make sure it is running, then try again.</p><p style="color:#777;font-size:12px">${address}</p><button onclick="location.reload()" style="margin-top:12px;padding:8px 14px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;font:inherit;cursor:pointer">Retry</button></main></body>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      },
    },
  );
}

const fetchWithTransientRetry = (url: string, init: RequestInit) =>
  netFetch(url, init).pipe(
    Effect.retry({ schedule: Schedule.exponential("50 millis", 3), times: 2 }),
  );

const proxyRequest = Effect.fn("desktop.protocol.proxyRequest")(function* (
  request: Request,
  targetOrigin: URL,
  contentSecurityPolicy: string,
  publicUi = false,
  document = false,
) {
  if (
    publicUi &&
    (targetOrigin.username ||
      targetOrigin.password ||
      (targetOrigin.protocol !== "https:" &&
        !(
          targetOrigin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(targetOrigin.hostname)
        )))
  )
    return new Response(null, { status: 403 });
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST && serverUiRendererId(requestUrl.host) === undefined) {
    return new Response(null, { status: 404 });
  }

  // Assign the path so leading slashes cannot replace the configured host.
  const targetUrl = new URL(targetOrigin);
  targetUrl.pathname =
    (targetOrigin.pathname.endsWith("/")
      ? targetOrigin.pathname.slice(0, -1)
      : targetOrigin.pathname) + requestUrl.pathname;
  targetUrl.search = requestUrl.search;
  const headers = new Headers(request.headers);
  const headersToRemove: string[] = [];
  for (const name of headers.keys()) {
    if (
      (publicUi && (name === "cookie" || name === "authorization")) ||
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name === "connection" ||
      name === "content-length" ||
      name === "accept-encoding" ||
      name === "upgrade-insecure-requests" ||
      name.startsWith("sec-fetch-")
    ) {
      headersToRemove.push(name);
    }
  }
  for (const name of headersToRemove) {
    headers.delete(name);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
    ...(publicUi ? { credentials: "omit" as const, redirect: "error" as const } : {}),
  };
  if (document || request.mode === "navigate") {
    init.cache = "no-store";
    init.signal = AbortSignal.timeout(5_000);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const response =
    request.method === "GET" || request.method === "HEAD"
      ? yield* fetchWithTransientRetry(targetUrl.toString(), init)
      : yield* netFetch(targetUrl.toString(), init);
  if (publicUi) {
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("set-cookie");
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    return withContentSecurityPolicy(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      }),
      contentSecurityPolicy,
    );
  }
  return withContentSecurityPolicy(response, contentSecurityPolicy);
});

const serveDesktopAsset = Effect.fn("desktop.protocol.serveAsset")(function* (
  request: Request,
  assetDirectory: string,
  document = false,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const url = new URL(request.url);
  if (url.host !== DESKTOP_HOST) return new Response(null, { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  const pathname = yield* Effect.try(() => decodeURIComponent(url.pathname)).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (pathname === null || pathname.includes("\0")) return new Response(null, { status: 400 });
  const root = path.resolve(assetDirectory);
  const assetPath = path.resolve(root, `.${pathname}`);
  if (assetPath !== root && !assetPath.startsWith(root + path.sep)) {
    return new Response(null, { status: 404 });
  }
  const stat = yield* fileSystem.stat(assetPath).pipe(Effect.orElseSucceed(() => null));
  let filePath = assetPath;
  if (stat?.type !== "File") {
    const wantsHtml = document || request.mode === "navigate";
    if (path.extname(assetPath) !== "" && !wantsHtml) {
      return new Response(null, { status: 404 });
    }
    filePath = path.join(root, "index.html");
  }
  const contents = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
  if (contents === null) return new Response(null, { status: 404 });
  return new Response(request.method === "HEAD" ? null : new Uint8Array(contents), {
    headers: {
      "content-type": Option.getOrElse(Mime.getType(filePath), () => "application/octet-stream"),
    },
  });
});

/** @public */
export const make = Effect.gen(function* () {
  const registered = yield* Ref.make(false);
  const navigations = new Map<number, string>();
  const pageOrigins = new Map<string, URL>();
  const currentOrigins = new Map<number, URL>();
  const trackWindow = Effect.fn("desktop.protocol.trackWindow")((contents: Electron.WebContents) =>
    Effect.sync(() => {
      const started = (
        event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ) => {
        if (event.isMainFrame && !event.isSameDocument) navigations.set(contents.id, event.url);
      };
      contents.on("did-start-navigation", started);
      contents.once("destroyed", () => {
        for (const host of pageOrigins.keys())
          if (serverUiRendererId(host) === contents.id) pageOrigins.delete(host);
        currentOrigins.delete(contents.id);
        navigations.delete(contents.id);
        contents.removeListener("did-start-navigation", started);
      });
    }),
  );
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runPromise = Effect.runPromiseWith(context);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if (yield* Ref.get(registered)) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy(input);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            Electron.protocol.handle(input.scheme, async (request) => {
              if ("assetDirectory" in input) {
                const requestUrl = new URL(request.url);
                const rendererId =
                  serverUiRendererId(requestUrl.host) ??
                  Number(requestUrl.searchParams.get("desktopWindowId"));
                const isDocument =
                  request.mode === "navigate" || navigations.get(rendererId) === request.url;
                if (isDocument) navigations.delete(rendererId);
                const serverHost = serverUiRendererId(requestUrl.host) !== undefined;
                const id = requestUrl.searchParams.get("desktopWindowId");
                if (
                  isDocument &&
                  requestUrl.host === DESKTOP_HOST &&
                  id &&
                  /^\d+$/.test(id) &&
                  !requestUrl.searchParams.has("bundled") &&
                  input.serverOrigin
                ) {
                  const origin = await input.serverOrigin();
                  if (origin) {
                    const next = `${input.scheme}://${sourceHost(Number(id), origin)}/`;
                    navigations.set(Number(id), next);
                    return Response.redirect(next, 302);
                  }
                }
                if (serverHost && isDocument && input.serverOrigin) {
                  const origin = await input.serverOrigin();
                  if (origin) {
                    if (requestUrl.host !== sourceHost(rendererId, origin)) {
                      const next = `${input.scheme}://${sourceHost(rendererId, origin)}/`;
                      navigations.set(rendererId, next);
                      return Response.redirect(next, 302);
                    }
                    const origins = (await input.connectionOrigins?.()) ?? [origin.origin];
                    const policy = makeDesktopContentSecurityPolicy(input, origins);
                    const response = await runPromise(
                      proxyRequest(request, origin, policy, true, true).pipe(
                        Effect.catchTags({
                          ElectronProtocolFetchError: (error) =>
                            Effect.logWarning("Server UI unavailable", error).pipe(Effect.as(null)),
                        }),
                      ),
                    );
                    if (
                      response?.ok &&
                      response.headers.get("content-type")?.includes("text/html") &&
                      response.headers.get("t3-desktop-ui-protocol") === "1" &&
                      response.headers.get("t3-desktop-bridge") === "reduced-1"
                    ) {
                      pageOrigins.set(requestUrl.host, origin);
                      currentOrigins.set(rendererId, origin);
                      await input.onSource?.(origin);
                      return response;
                    }
                  }
                  pageOrigins.delete(requestUrl.host);
                  currentOrigins.delete(rendererId);
                  await input.onSource?.(
                    null,
                    "Server UI unavailable or incompatible; using bundled client",
                  );
                  const fallback = new URL(`${input.scheme}://app/`);
                  fallback.searchParams.set("desktopWindowId", String(rendererId));
                  fallback.searchParams.set("bundled", "1");
                  // Only the origin: no path, query or userinfo belongs in the navigation map or history.
                  if (origin) fallback.searchParams.set("server", origin.origin);
                  const name = input.serverName ? await input.serverName() : null;
                  if (name) fallback.searchParams.set("name", name.trim().slice(0, 60));
                  navigations.set(rendererId, fallback.href);
                  return Response.redirect(fallback.href, 302);
                }
                if (serverHost) {
                  const origin = pageOrigins.get(requestUrl.host);
                  if (!origin) return new Response(null, { status: 404 });
                  return runPromise(
                    proxyRequest(
                      request,
                      origin,
                      makeDesktopContentSecurityPolicy(
                        input,
                        (await input.connectionOrigins?.()) ?? [origin.origin],
                      ),
                      true,
                    ),
                  );
                }
                if (
                  isDocument &&
                  requestUrl.searchParams.has("bundled") &&
                  currentOrigins.delete(rendererId)
                ) {
                  await input.onSource?.(null, "Local desktop settings");
                }
                return withContentSecurityPolicy(
                  await runPromise(serveDesktopAsset(request, input.assetDirectory, isDocument)),
                  contentSecurityPolicy,
                );
              }
              return runPromise(
                proxyRequest(request, input.targetOrigin, contentSecurityPolicy).pipe(
                  Effect.catchTags({
                    ElectronProtocolFetchError: (error) =>
                      request.mode === "navigate"
                        ? Effect.succeed(offlineShellResponse(input.targetOrigin))
                        : Effect.die(error.cause),
                  }),
                ),
              );
            });
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, true))),
        () =>
          Effect.try({
            try: () => Electron.protocol.unhandle(input.scheme),
            catch: (cause) =>
              new ElectronProtocolUnregistrationError({
                scheme: input.scheme,
                cause,
              }),
          }).pipe(Effect.andThen(Ref.set(registered, false)), Effect.orDie),
      );
    },
  );

  return ElectronProtocol.of({
    registerDesktopProtocol,
    trackWindow,
    serverOriginFor: Effect.fn("desktop.protocol.serverOriginFor")((id: number) =>
      Effect.sync(() => currentOrigins.get(id)?.href ?? null),
    ),
  });
});

export const layer = Layer.effect(ElectronProtocol, make);
