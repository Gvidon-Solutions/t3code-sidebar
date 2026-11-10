// @effect-diagnostics-next-line nodeBuiltinImport:off -- Source-specific renderer origins are computed before document navigation.
import * as NodeCrypto from "node:crypto";
import { serverUiRendererId } from "../ipc/rendererTrust.ts";
import * as Clock from "effect/Clock";
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

/** Stable for the install, so browser storage is not orphaned on a restart. */
export function serverUiSourceHost(id: number, origin: URL, salt: string): string {
  return `server-${id}-${NodeCrypto.createHash("sha256")
    .update(`${salt}\0${origin.href}`)
    .digest("hex")
    .slice(0, 24)}`;
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

export type DesktopAssetProtocolInput = Extract<
  DesktopProtocolRegistrationInput,
  { assetDirectory: string }
>;

export type DesktopProtocolRegistrationInput = {
  readonly scheme: string;
  readonly clerkFrontendApiHostname: string | undefined;
  readonly connectionOrigins?: () => Promise<ReadonlyArray<string>>;
} & (
  | { readonly targetOrigin: URL }
  | {
      readonly assetDirectory: string;
      readonly sourceSalt: string;
      readonly serverOrigin?: () => Promise<URL | null>;
      readonly serverName?: () => Promise<string | null>;
      readonly serverAuthorization?: (
        origin: URL,
      ) => Promise<{ readonly authorization: string; readonly environmentId: string } | null>;
      readonly noteAuthorizationRejected?: (origin: URL, authorization: string) => Promise<void>;
      readonly onSource?: (origin: URL | null, reason?: string) => Promise<void>;
    }
);

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly serverOriginFor: (rendererId: number) => Effect.Effect<string | null>;
    readonly serverUiRequestTokenFor: (host: string) => Effect.Effect<string | null>;
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
    "frame-ancestors 'self'",
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

interface ServerUiCookie {
  readonly name: string;
  readonly value: string;
  readonly expiresAt: number | null;
  readonly path: string;
}

interface ServerUiSession {
  readonly cookies: Map<string, ServerUiCookie>;
  readonly requestToken: string;
  authorization: string | null;
  environmentId: string | null;
}

const SERVER_UI_REQUEST_HEADER = "x-t3-server-ui";

function readSetCookieHeaders(headers: Headers): ReadonlyArray<string> {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") return getSetCookie.call(headers);
  const value = headers.get("set-cookie");
  return value === null ? [] : [value];
}

const cookieKey = (name: string, path: string) => `${name}\u0000${path}`;

function cookieAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const firstSemicolon = raw.indexOf(";");
  if (firstSemicolon === -1) return attributes;
  for (const part of raw.slice(firstSemicolon + 1).split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    attributes.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  return attributes;
}

function cookieExpiry(raw: string, now: number): number | null {
  const attributes = cookieAttributes(raw);
  const maxAge = attributes.get("max-age");
  if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) {
    return now + Number(maxAge) * 1_000;
  }
  const expires = attributes.get("expires");
  if (expires !== undefined) {
    const at = Date.parse(expires);
    return Number.isNaN(at) ? null : at;
  }
  return null;
}

/** Keeps browser-session cookies in the shell, never in the reduced server UI. */
function mergeServerUiCookies(session: ServerUiSession, response: Response, now: number): void {
  for (const raw of readSetCookieHeaders(response.headers)) {
    const pair = raw.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name.length === 0) continue;
    const path = cookieAttributes(raw).get("path") ?? "/";
    const expiresAt = cookieExpiry(raw, now);
    const key = cookieKey(name, path);
    if (value.length === 0 || (expiresAt !== null && expiresAt <= now)) {
      session.cookies.delete(key);
      continue;
    }
    session.cookies.set(key, { name, value, expiresAt, path });
  }
}

function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  if (cookiePath === "/") return true;
  const base = cookiePath.endsWith("/") ? cookiePath.slice(0, -1) : cookiePath;
  return requestPath === base || requestPath.startsWith(`${base}/`);
}

function cookieHeader(session: ServerUiSession, now: number, requestPath: string): string | null {
  const pairs: string[] = [];
  for (const [key, cookie] of session.cookies) {
    if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
      session.cookies.delete(key);
      continue;
    }
    if (!cookiePathMatches(requestPath, cookie.path)) continue;
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.length === 0 ? null : pairs.join("; ");
}

const proxyRequest = Effect.fn("desktop.protocol.proxyRequest")(function* (
  request: Request,
  targetOrigin: URL,
  contentSecurityPolicy: string,
  options: {
    readonly serverUi?: boolean;
    readonly session?: ServerUiSession;
    readonly document?: boolean;
  } = {},
) {
  const serverUi = options.serverUi ?? false;
  if (
    serverUi &&
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
      ((serverUi || options.session !== undefined) &&
        (name === "cookie" || name === "authorization")) ||
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
  const now = yield* Clock.currentTimeMillis;
  const requestToken = headers.get(SERVER_UI_REQUEST_HEADER);
  const hasRequestToken =
    options.session !== undefined &&
    requestToken !== null &&
    requestToken === options.session.requestToken;
  headers.delete(SERVER_UI_REQUEST_HEADER);
  const injectCredentials =
    options.session !== undefined && (options.document === true || hasRequestToken);
  const injectedAuthorization = injectCredentials ? options.session!.authorization : null;
  const injectedCookie = injectCredentials
    ? cookieHeader(options.session!, now, targetUrl.pathname)
    : null;
  if (options.session !== undefined) {
    if (injectedCookie !== null) headers.set("cookie", injectedCookie);
    if (injectedAuthorization !== null) {
      headers.set("authorization", `Bearer ${injectedAuthorization}`);
    }
    // The server's cookie-origin defence must see a real origin. The shell is the
    // trusted caller of a first-party session, so it names the server itself.
    if (injectedAuthorization !== null || injectedCookie !== null) {
      headers.set("origin", targetOrigin.origin);
      // A Host-rewriting reverse proxy must still tell the server the public host.
      headers.set("x-forwarded-host", targetOrigin.host);
    }
  }
  const init: RequestInit = {
    method: request.method,
    headers,
    ...(serverUi
      ? {
          // Only an authorized (or main-document) request may see the cookie store or the
          // shell jar; a sandboxed frame's no-token request must stay credential-free.
          credentials:
            hasRequestToken || options.document === true ? ("include" as const) : ("omit" as const),
          redirect: "error" as const,
        }
      : {}),
  };
  if (options.document || request.mode === "navigate") {
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
  if (serverUi) {
    if (options.session !== undefined) {
      mergeServerUiCookies(options.session, response, now);
      if (response.status === 401) options.session.cookies.clear();
    }
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
  const serverUiSessions = new Map<string, ServerUiSession>();
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
        for (const host of serverUiSessions.keys())
          if (serverUiRendererId(host) === contents.id) serverUiSessions.delete(host);
        currentOrigins.delete(contents.id);
        navigations.delete(contents.id);
        contents.removeListener("did-start-navigation", started);
      });
    }),
  );
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runPromise = Effect.runPromiseWith(context);
  const serverUiSession = (
    host: string,
    credential: { readonly authorization: string; readonly environmentId: string } | null,
  ): ServerUiSession => {
    const existing = serverUiSessions.get(host);
    if (existing === undefined) {
      const created: ServerUiSession = {
        cookies: new Map(),
        requestToken: NodeCrypto.randomBytes(24).toString("hex"),
        authorization: credential?.authorization ?? null,
        environmentId: credential?.environmentId ?? null,
      };
      serverUiSessions.set(host, created);
      return created;
    }
    // A different credential must never inherit the previous session's cookie jar, because
    // the server prefers the cookie over the bearer.
    if (
      existing.authorization !== (credential?.authorization ?? null) ||
      existing.environmentId !== (credential?.environmentId ?? null)
    ) {
      existing.cookies.clear();
      existing.authorization = credential?.authorization ?? null;
      existing.environmentId = credential?.environmentId ?? null;
    }
    return existing;
  };
  const clearOtherServerUiSources = (rendererId: number, keepHost?: string): void => {
    for (const host of pageOrigins.keys()) {
      if (host === keepHost || serverUiRendererId(host) !== rendererId) continue;
      pageOrigins.delete(host);
      serverUiSessions.delete(host);
    }
  };
  const isSameServerUiCaller = (request: Request, requestUrl: URL): boolean => {
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    const scheme = request.url.slice(0, request.url.indexOf(":"));
    // Chromium omits these on custom-scheme subresources. When they are present they
    // are browser-set and cannot be forged; the per-install host salt then keeps another
    // window's source host unguessable.
    if (origin !== null && origin !== `${scheme}://${requestUrl.host}`) return false;
    if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") return false;
    return true;
  };
  const serverCredentialAccepted = async (
    origin: URL,
    authorization: string,
    cookie: string | null = null,
  ): Promise<boolean> => {
    try {
      const sessionUrl = `${origin.href.replace(/\/$/, "")}/api/auth/session`;
      const response = await runPromise(
        netFetch(sessionUrl, {
          headers: {
            authorization: `Bearer ${authorization}`,
            ...(cookie === null ? {} : { cookie }),
          },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        }).pipe(Effect.retry({ schedule: Schedule.exponential("50 millis", 3), times: 1 })),
      );
      if (response.status === 401) return false;
      // 403 is an authorization/proxy decision, not a bad token; do not lock the UI out.
      if (response.status === 403) return true;
      if (response.ok) {
        const body: unknown = await response.json().catch(() => null);
        if (
          typeof body === "object" &&
          body !== null &&
          "authenticated" in body &&
          typeof body.authenticated === "boolean"
        ) {
          return body.authenticated;
        }
      }
      return true;
    } catch {
      // Unreachable is not a rejected credential; the document request decides.
      return true;
    }
  };
  const redirectToBundled = async (
    input: DesktopAssetProtocolInput,
    origin: URL | null,
    rendererId: number,
    host: string,
    fallbackOptions: { readonly auth?: boolean } = {},
  ): Promise<Response> => {
    // Keep the shell session across a transient outage; the same server may come back.
    pageOrigins.delete(host);
    currentOrigins.delete(rendererId);
    await input.onSource?.(
      null,
      fallbackOptions.auth
        ? "Server UI authentication failed; using bundled client"
        : "Server UI unavailable or incompatible; using bundled client",
    );
    const fallback = new URL(`${input.scheme}://app/`);
    fallback.searchParams.set("desktopWindowId", String(rendererId));
    fallback.searchParams.set("bundled", "1");
    // An auth failure is not an outage: the bundled client can still use its saved
    // connections, so it must render the normal app rather than the offline page.
    if (fallbackOptions.auth) fallback.searchParams.set("auth", "1");
    // Only the origin: no path, query or userinfo belongs in the navigation map or history.
    if (origin) fallback.searchParams.set("server", origin.origin);
    const name = input.serverName ? await input.serverName() : null;
    if (name) fallback.searchParams.set("name", name.trim().slice(0, 60));
    navigations.set(rendererId, fallback.href);
    return Response.redirect(fallback.href, 302);
  };

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
                // Only the main-frame navigation recorded for this renderer is a document.
                // Subframe navigations (previews, MCP apps, guest HTML) are subresources.
                const serverHost = serverUiRendererId(requestUrl.host) !== undefined;
                // Server-host documents require the main-frame navigation recorded for this
                // renderer. Subframe navigations are subresources and never get credentials.
                const isDocument = serverHost
                  ? navigations.get(rendererId) === request.url
                  : request.mode === "navigate" || navigations.get(rendererId) === request.url;
                if (isDocument) navigations.delete(rendererId);
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
                    const next = `${input.scheme}://${serverUiSourceHost(Number(id), origin, input.sourceSalt)}/`;
                    navigations.set(Number(id), next);
                    return Response.redirect(next, 302);
                  }
                }
                if (serverHost && isDocument && input.serverOrigin) {
                  const origin = await input.serverOrigin();
                  if (origin) {
                    if (
                      requestUrl.host !== serverUiSourceHost(rendererId, origin, input.sourceSalt)
                    ) {
                      clearOtherServerUiSources(rendererId, requestUrl.host);
                      const next = `${input.scheme}://${serverUiSourceHost(rendererId, origin, input.sourceSalt)}/`;
                      navigations.set(rendererId, next);
                      return Response.redirect(next, 302);
                    }
                    const credential = (await input.serverAuthorization?.(origin)) ?? null;
                    const session = serverUiSession(requestUrl.host, credential);
                    const authorization = credential?.authorization ?? null;
                    if (authorization !== null) {
                      const sessionPath = `${origin.pathname.replace(/\/$/, "")}/api/auth/session`;
                      const now = await runPromise(Clock.currentTimeMillis);
                      const jarCookie =
                        session.cookies.size === 0 ? null : cookieHeader(session, now, sessionPath);
                      let accepted = await serverCredentialAccepted(
                        origin,
                        authorization,
                        jarCookie,
                      );
                      if (!accepted && jarCookie !== null) {
                        // A stale jar cookie shadows the valid bearer; drop it and retry.
                        session.cookies.clear();
                        accepted = await serverCredentialAccepted(origin, authorization, null);
                      }
                      if (!accepted) {
                        await input.noteAuthorizationRejected?.(origin, authorization);
                        // The trusted client's credential no longer works, so server UI auth
                        // is impossible. Return to the bundled client with saved connections.
                        return await redirectToBundled(input, origin, rendererId, requestUrl.host, {
                          auth: true,
                        });
                      }
                    }
                    const origins = (await input.connectionOrigins?.()) ?? [origin.origin];
                    const policy = makeDesktopContentSecurityPolicy(input, origins);
                    const response = await runPromise(
                      proxyRequest(request, origin, policy, {
                        serverUi: true,
                        session,
                        document: true,
                      }).pipe(
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
                      clearOtherServerUiSources(rendererId, requestUrl.host);
                      pageOrigins.set(requestUrl.host, origin);
                      currentOrigins.set(rendererId, origin);
                      await input.onSource?.(origin);
                      return response;
                    }
                  }
                  return await redirectToBundled(input, origin, rendererId, requestUrl.host);
                }
                if (serverHost) {
                  const origin = pageOrigins.get(requestUrl.host);
                  if (!origin) return new Response(null, { status: 404 });
                  if (!isSameServerUiCaller(request, requestUrl)) {
                    return new Response(null, { status: 403 });
                  }
                  const credential = (await input.serverAuthorization?.(origin)) ?? null;
                  return runPromise(
                    proxyRequest(
                      request,
                      origin,
                      makeDesktopContentSecurityPolicy(
                        input,
                        (await input.connectionOrigins?.()) ?? [origin.origin],
                      ),
                      {
                        serverUi: true,
                        session: serverUiSession(requestUrl.host, credential),
                      },
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
    serverUiRequestTokenFor: Effect.fn("desktop.protocol.serverUiRequestTokenFor")((host: string) =>
      Effect.sync(() => serverUiSessions.get(host)?.requestToken ?? null),
    ),
  });
});

export const layer = Layer.effect(ElectronProtocol, make);
