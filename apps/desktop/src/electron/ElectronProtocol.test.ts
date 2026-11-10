import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { handleMock, netFetchMock, unhandleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  netFetchMock: vi.fn(),
  unhandleMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock, unhandle: unhandleMock },
  session: {
    fromPartition: () => ({
      fetch: netFetchMock,
      cookies: { get: async () => [], remove: async () => undefined },
    }),
    defaultSession: {
      fetch: netFetchMock,
      cookies: { get: async () => [], remove: async () => undefined },
    },
  },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";
function navigation(url: string, init?: RequestInit) {
  const request = new Request(url, init);
  Object.defineProperty(request, "mode", { value: "navigate" });
  return request;
}

const layerProtocol = ElectronProtocol.layer.pipe(Layer.provide(NodeServices.layer));

describe("ElectronProtocol", () => {
  beforeEach(() => {
    handleMock.mockReset();
    netFetchMock.mockReset();
    unhandleMock.mockReset();
  });

  it.effect("serves the bundled client from disk without a backend", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${directory}/index.html`, "<html>app</html>");
      yield* fileSystem.writeFileString(`${directory}/app.js`, "export default 1;");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        sourceSalt: "test-salt",
        clerkFrontendApiHostname: undefined,
      });
      const request = (pathname: string, init?: RequestInit) =>
        Effect.promise(() =>
          handler!(
            init?.headers && new Headers(init.headers).get("accept")?.includes("text/html")
              ? navigation(`t3code://app${pathname}`, init)
              : new Request(`t3code://app${pathname}`, init),
          ),
        );

      const page = yield* request("/settings/connections");
      assert.equal(yield* Effect.promise(() => page.text()), "<html>app</html>");
      assert.include(page.headers.get("content-security-policy") ?? "", "default-src 'self'");
      const dottedRoute = yield* request("/environment/thread.with.dots", {
        headers: { accept: "text/html" },
      });
      assert.equal(yield* Effect.promise(() => dottedRoute.text()), "<html>app</html>");

      const script = yield* request("/app.js?v=1");
      assert.equal(yield* Effect.promise(() => script.text()), "export default 1;");
      assert.include(script.headers.get("content-type") ?? "", "javascript");

      assert.equal((yield* request("/missing.js")).status, 404);
      assert.equal((yield* request("/%2e%2e%2fsecret.txt")).status, 404);
      assert.equal((yield* request("/%invalid")).status, 400);
      assert.equal((yield* request("/", { method: "POST" })).status, 405);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );

  it.effect("proxies the stable renderer origin to the current app server", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("ok"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code-dev",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: "clerk.t3.codes",
          });
          assert.isDefined(handler);

          const response = yield* Effect.promise(() =>
            handler!(
              new Request("t3code-dev://app/api/health?verbose=1", {
                headers: {
                  accept: "application/json",
                  origin: "t3code-dev://app",
                  referer: "t3code-dev://app/",
                  "sec-fetch-site": "same-origin",
                },
              }),
            ),
          );
          assert.equal(yield* Effect.promise(() => response.text()), "ok");
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://clerk.t3.codes https://challenges.cloudflare.com",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "connect-src 'self' blob: http: https: ws: wss:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "img-src 'self' t3code-dev: blob: data: http: https:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "font-src 'self' t3code-dev: data:",
          );
        }),
      );

      assert.deepEqual(
        handleMock.mock.calls.map((call) => call[0]),
        ["t3code-dev"],
      );
      assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/api/health?verbose=1");
      const forwardedHeaders = new Headers(netFetchMock.mock.calls[0]?.[1]?.headers);
      assert.equal(forwardedHeaders.get("accept"), "application/json");
      assert.isNull(forwardedHeaders.get("origin"));
      assert.isNull(forwardedHeaders.get("referer"));
      assert.isNull(forwardedHeaders.get("sec-fetch-site"));
      assert.deepEqual(unhandleMock.mock.calls, [["t3code-dev"]]);
    }).pipe(Effect.provide(layerProtocol)),
  );

  it("renders a retry page when the dev target server is unreachable", async () => {
    const response = ElectronProtocol.offlineShellResponse(new URL("http://127.0.0.1:3773/"));
    assert.equal(response.status, 503);
    const html = await response.text();
    assert.include(html, "Can't reach the server");
    assert.include(
      html,
      "T3 Code can't reach the server. Make sure it is running, then try again.",
    );
    assert.include(html, "127.0.0.1:3773");
    assert.notInclude(html, "bundled UI");
    assert.include(html, "Retry");
    assert.include(response.headers.get("content-security-policy") ?? "", "default-src 'none'");
  });

  it.effect("keeps proxied paths on the configured server", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockImplementation(async () => new Response("ok"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code-dev",
            targetOrigin: new URL("http://127.0.0.1:5733/"),
            clerkFrontendApiHostname: undefined,
          });
          yield* Effect.promise(() =>
            handler!(new Request("t3code-dev://app//example.com/src/main.tsx?t=1")),
          );
          yield* Effect.promise(() => handler!(new Request("t3code-dev://app/\\example.com/")));
        }),
      );

      assert.deepEqual(
        netFetchMock.mock.calls.map((call) => call[0]),
        [
          "http://127.0.0.1:5733//example.com/src/main.tsx?t=1",
          "http://127.0.0.1:5733//example.com/",
        ],
      );
    }).pipe(Effect.provide(layerProtocol)),
  );

  it.effect("rejects custom protocol requests for another host", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("t3code://other/")));
        }),
      );

      assert.equal(response.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(layerProtocol)),
  );
  it.effect("loads changed server UI on navigation and retains the bundled offline client", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(directory + "/index.html", "bundled");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      let desiredOrigin = new URL("https://studio.example/prefix/");
      let latestSource: URL | null | undefined;
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        sourceSalt: "test-salt",
        serverOrigin: async () => desiredOrigin,
        serverName: async () => "Studio",
        onSource: async (origin) => {
          latestSource = origin;
        },
        clerkFrontendApiHostname: undefined,
      });
      let pageUrl = "";
      const page = (id = 1) =>
        Effect.promise(async () => {
          const redirect = await handler!(navigation(`t3code://app/?desktopWindowId=${id}`));
          pageUrl = redirect.headers.get("location")!;
          return handler!(
            navigation(pageUrl, {
              headers: {
                accept: "text/html",
                cookie: "local=secret",
                authorization: "Bearer local-secret",
              },
            }),
          );
        });
      netFetchMock.mockImplementation(
        async () =>
          new Response("server-v1", {
            headers: {
              "content-type": "text/html",
              "t3-desktop-ui-protocol": "1",
              "t3-desktop-bridge": "reduced-1",
              "set-cookie": "remote=secret",
            },
          }),
      );
      const first = yield* page();
      assert.equal(yield* Effect.promise(() => first.text()), "server-v1");
      assert.equal(netFetchMock.mock.calls.at(-1)?.[0], "https://studio.example/prefix/");
      const forwardedHeaders = netFetchMock.mock.calls.at(-1)?.[1].headers as Headers;
      assert.isFalse(forwardedHeaders.has("cookie"));
      assert.isFalse(forwardedHeaders.has("authorization"));
      assert.isNull(first.headers.get("set-cookie"));
      assert.include(first.headers.get("content-security-policy")!, "object-src 'none'");
      assert.include(
        first.headers.get("content-security-policy")!,
        "connect-src 'self' https://studio.example wss://studio.example",
      );
      assert.notInclude(
        first.headers.get("content-security-policy")!,
        "connect-src 'self' blob: http:",
      );
      assert.isNull(first.headers.get("content-encoding"));
      assert.isNull(first.headers.get("content-length"));
      yield* Effect.promise(() =>
        handler!(navigation("t3code://app/?desktopWindowId=1&bundled=1")),
      );
      assert.isNull(latestSource);
      assert.isNull(yield* protocol.serverOriginFor(1));
      yield* page();
      const studioPage = pageUrl;
      desiredOrigin = new URL("https://cloudbox.example/");
      yield* Effect.promise(() =>
        handler!(
          new Request(new URL("assets/old.js", studioPage), {
            headers: { "sec-fetch-site": "same-origin" },
          }),
        ),
      );
      assert.equal(
        netFetchMock.mock.calls.at(-1)?.[0],
        "https://studio.example/prefix/assets/old.js",
      );
      netFetchMock.mockImplementation(
        async () =>
          new Response("server-v2", {
            headers: {
              "content-type": "text/html",
              "t3-desktop-ui-protocol": "1",
              "t3-desktop-bridge": "reduced-1",
            },
          }),
      );
      yield* Effect.promise(() =>
        handler!(
          new Request(new URL("pretend-document", studioPage), {
            headers: { accept: "text/html", "sec-fetch-site": "same-origin" },
          }),
        ),
      );
      assert.equal(
        netFetchMock.mock.calls.at(-1)?.[0],
        "https://studio.example/prefix/pretend-document",
      );
      yield* page(2);
      assert.equal(yield* protocol.serverOriginFor(1), "https://studio.example/prefix/");
      assert.equal(yield* protocol.serverOriginFor(2), "https://cloudbox.example/");
      const second = yield* page();
      assert.notEqual(new URL(pageUrl).host, new URL(studioPage).host);
      assert.equal(yield* Effect.promise(() => second.text()), "server-v2");
      assert.equal(netFetchMock.mock.calls.at(-1)?.[0], "https://cloudbox.example/");
      netFetchMock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
      const offline = yield* page();
      assert.equal(offline.status, 302);
      const fallback = new URL(offline.headers.get("location")!);
      assert.equal(fallback.searchParams.get("bundled"), "1");
      assert.isNull(fallback.searchParams.get("auth"));
      assert.equal(fallback.searchParams.get("server"), "https://cloudbox.example");
      assert.equal(fallback.searchParams.get("name"), "Studio");
      netFetchMock.mockImplementation(
        async () =>
          new Response("server-v3", {
            headers: {
              "content-type": "text/html",
              "t3-desktop-ui-protocol": "1",
              "t3-desktop-bridge": "reduced-1",
            },
          }),
      );
      const recovered = yield* page();
      assert.equal(yield* Effect.promise(() => recovered.text()), "server-v3");
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );

  it.effect("keeps the server UI browser session in the shell proxy", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(directory + "/index.html", "bundled");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        sourceSalt: "test-salt",
        serverOrigin: async () => new URL("https://studio.example/"),
        serverAuthorization: async () => null,
        clerkFrontendApiHostname: undefined,
      });
      netFetchMock.mockImplementation(async (url: string) => {
        if (String(url).endsWith("/api/auth/session")) {
          return new Response('{"authenticated":true}', {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("server", {
          headers: {
            "content-type": "text/html",
            "t3-desktop-ui-protocol": "1",
            "t3-desktop-bridge": "reduced-1",
            "set-cookie": "session=abc; Path=/; HttpOnly; SameSite=Lax",
          },
        });
      });
      const redirect = yield* Effect.promise(() =>
        handler!(navigation("t3code://app/?desktopWindowId=1")),
      );
      const pageUrl = redirect.headers.get("location")!;
      yield* Effect.promise(() => handler!(navigation("t3code://app/?desktopWindowId=1")));
      yield* Effect.promise(() =>
        handler!(navigation(pageUrl, { headers: { accept: "text/html" } })),
      );
      const requestToken = yield* protocol.serverUiRequestTokenFor(new URL(pageUrl).host);
      assert.ok(requestToken);
      const api = yield* Effect.promise(() =>
        handler!(
          new Request(new URL("api/auth/session", pageUrl), {
            headers: { "sec-fetch-site": "same-origin", "x-t3-server-ui": requestToken },
          }),
        ),
      );
      assert.equal(yield* Effect.promise(() => api.text()), '{"authenticated":true}');
      assert.isNull(api.headers.get("set-cookie"));
      const forwarded = netFetchMock.mock.calls.at(-1)?.[1].headers as Headers;
      assert.equal(forwarded.get("cookie"), "session=abc");
      assert.isFalse(forwarded.has("authorization"));
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );

  it.effect("proxies the shell-held credential and falls back when it is rejected", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(directory + "/index.html", "bundled");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      let credential: { authorization: string; environmentId: string } | null = {
        authorization: "good-token",
        environmentId: "studio",
      };
      const rejected: Array<string> = [];
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        sourceSalt: "test-salt",
        serverOrigin: async () => new URL("https://studio.example/"),
        serverName: async () => "Studio",
        serverAuthorization: async () => credential,
        noteAuthorizationRejected: async (_origin, token) => {
          rejected.push(token);
        },
        clerkFrontendApiHostname: undefined,
      });
      netFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/api/auth/session")) {
          const headers = new Headers(init?.headers);
          return headers.get("authorization") === "Bearer good-token"
            ? new Response('{"authenticated":true}', {
                headers: { "content-type": "application/json" },
              })
            : new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
        }
        return new Response("server", {
          headers: {
            "content-type": "text/html",
            "t3-desktop-ui-protocol": "1",
            "t3-desktop-bridge": "reduced-1",
          },
        });
      });
      const redirect = yield* Effect.promise(() =>
        handler!(navigation("t3code://app/?desktopWindowId=1")),
      );
      const pageUrl = redirect.headers.get("location")!;
      const document = yield* Effect.promise(() =>
        handler!(navigation(pageUrl, { headers: { accept: "text/html" } })),
      );
      assert.equal(yield* Effect.promise(() => document.text()), "server");
      const forwarded = netFetchMock.mock.calls.at(-1)?.[1].headers as Headers;
      assert.equal(forwarded.get("authorization"), "Bearer good-token");

      credential = { authorization: "expired-token", environmentId: "studio" };
      yield* Effect.promise(() => handler!(navigation("t3code://app/?desktopWindowId=1")));
      const fallback = yield* Effect.promise(() =>
        handler!(navigation(pageUrl, { headers: { accept: "text/html" } })),
      );
      assert.equal(fallback.status, 302);
      const location = new URL(fallback.headers.get("location")!);
      assert.equal(location.searchParams.get("bundled"), "1");
      assert.equal(location.searchParams.get("auth"), "1");
      assert.deepEqual(rejected, ["expired-token"]);
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );
  it.effect("honours cookie expiry, Max-Age attributes and Path without shadowing the bearer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(directory + "/index.html", "bundled");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      let setCookies = [
        "session=abc; Path=/; HttpOnly",
        "api-only=yes; Path=/api; HttpOnly",
        "weird=max-age=0; Path=/; HttpOnly",
        "expired=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
        "future=ok; Expires=Wed, 01 Jan 2030 00:00:00 GMT; Path=/",
      ];
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        sourceSalt: "test-salt",
        serverOrigin: async () => new URL("https://studio.example/"),
        serverAuthorization: async () => null,
        clerkFrontendApiHostname: undefined,
      });
      const documentResponse = () => {
        const headers = new Headers({
          "content-type": "text/html",
          "t3-desktop-ui-protocol": "1",
          "t3-desktop-bridge": "reduced-1",
        });
        for (const cookie of setCookies) headers.append("set-cookie", cookie);
        return new Response("server", { headers });
      };
      netFetchMock.mockResolvedValue(documentResponse());
      const redirect = yield* Effect.promise(() =>
        handler!(navigation("t3code://app/?desktopWindowId=1")),
      );
      const pageUrl = redirect.headers.get("location")!;
      yield* Effect.promise(() => handler!(navigation("t3code://app/?desktopWindowId=1")));
      yield* Effect.promise(() =>
        handler!(navigation(pageUrl, { headers: { accept: "text/html" } })),
      );
      const requestToken = yield* protocol.serverUiRequestTokenFor(new URL(pageUrl).host);
      assert.ok(requestToken);

      const readCookie = (url: URL) =>
        Effect.gen(function* () {
          netFetchMock.mockImplementation(async () => new Response("{}"));
          yield* Effect.promise(() =>
            handler!(
              new Request(url, {
                headers: {
                  "sec-fetch-site": "same-origin",
                  "x-t3-server-ui": requestToken,
                  cookie: "local=secret",
                  authorization: "Bearer local-secret",
                },
              }),
            ),
          );
          const headers = netFetchMock.mock.calls.at(-1)?.[1].headers as Headers;
          return headers.get("cookie");
        });
      const apiCookies = yield* readCookie(new URL("api/auth/session", pageUrl));
      assert.include(apiCookies ?? "", "session=abc");
      assert.include(apiCookies ?? "", "api-only=yes");
      assert.include(apiCookies ?? "", "weird=max-age=0");
      assert.include(apiCookies ?? "", "future=ok");
      assert.notInclude(apiCookies ?? "", "expired=gone");
      assert.notInclude(apiCookies ?? "", "local=secret");
      const otherHeaders = netFetchMock.mock.calls.at(-1)?.[1].headers as Headers;
      assert.equal(otherHeaders.get("authorization"), null);

      const otherCookies = yield* readCookie(new URL("v1/other", pageUrl));
      assert.include(otherCookies ?? "", "session=abc");
      assert.notInclude(otherCookies ?? "", "api-only=yes");

      setCookies = ["session=; Max-Age=0; Path=/"];
      netFetchMock.mockResolvedValue(documentResponse());
      yield* Effect.promise(() => handler!(navigation("t3code://app/?desktopWindowId=1")));
      yield* Effect.promise(() =>
        handler!(navigation(pageUrl, { headers: { accept: "text/html" } })),
      );
      const afterLogout = yield* readCookie(new URL("api/auth/session", pageUrl));
      assert.notInclude(afterLogout ?? "", "session=abc");
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );

  it.effect("rejects cross-host subresources and drops stale page origins", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(directory + "/index.html", "bundled");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      let origin = new URL("https://studio.example/");
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        sourceSalt: "test-salt",
        serverOrigin: async () => origin,
        serverAuthorization: async () => ({
          authorization: "studio-token",
          environmentId: "studio",
        }),
        clerkFrontendApiHostname: undefined,
      });
      netFetchMock.mockImplementation(async (url: string) => {
        if (String(url).endsWith("/api/auth/session")) {
          return Response.json({ authenticated: true });
        }
        return new Response("server", {
          headers: {
            "content-type": "text/html",
            "t3-desktop-ui-protocol": "1",
            "t3-desktop-bridge": "reduced-1",
          },
        });
      });
      const redirect = yield* Effect.promise(() =>
        handler!(navigation("t3code://app/?desktopWindowId=1")),
      );
      const studioPage = redirect.headers.get("location")!;
      yield* Effect.promise(() =>
        handler!(navigation(studioPage, { headers: { accept: "text/html" } })),
      );
      const requestToken = yield* protocol.serverUiRequestTokenFor(new URL(studioPage).host);
      assert.ok(requestToken);
      const before = netFetchMock.mock.calls.length;
      const cross = yield* Effect.promise(() =>
        handler!(
          new Request(new URL("api/auth/session", studioPage), {
            headers: {
              origin: "https://evil.example",
              "sec-fetch-site": "cross-site",
              "x-t3-server-ui": requestToken,
            },
          }),
        ),
      );
      assert.equal(cross.status, 403);
      assert.equal(netFetchMock.mock.calls.length, before);

      const same = yield* Effect.promise(() =>
        handler!(
          new Request(new URL("api/thing", studioPage), {
            headers: { "sec-fetch-site": "same-origin", "x-t3-server-ui": requestToken },
          }),
        ),
      );
      assert.equal(same.status, 200);
      const forwarded = netFetchMock.mock.calls.at(-1)?.[1].headers as Headers;
      assert.equal(forwarded.get("authorization"), "Bearer studio-token");
      assert.equal(forwarded.get("origin"), "https://studio.example");
      assert.equal(forwarded.get("x-forwarded-host"), "studio.example");

      // A sandboxed frame has no request token, so it must not get credentials.
      const withoutToken = yield* Effect.promise(() =>
        handler!(
          new Request(new URL("api/thing", studioPage), {
            headers: { "sec-fetch-site": "same-origin" },
          }),
        ),
      );
      assert.equal(withoutToken.status, 200);
      const uncredentialed = netFetchMock.mock.calls.at(-1)?.[1].headers as Headers;
      assert.isFalse(uncredentialed.has("authorization"));
      assert.isFalse(uncredentialed.has("cookie"));

      origin = new URL("https://cloudbox.example/");
      const secondRedirect = yield* Effect.promise(() =>
        handler!(navigation("t3code://app/?desktopWindowId=1")),
      );
      const cloudboxPage = secondRedirect.headers.get("location")!;
      yield* Effect.promise(() =>
        handler!(navigation(cloudboxPage, { headers: { accept: "text/html" } })),
      );
      const stale = yield* Effect.promise(() =>
        handler!(
          new Request(new URL("api/thing", studioPage), {
            headers: { "sec-fetch-site": "same-origin", "x-t3-server-ui": requestToken },
          }),
        ),
      );
      assert.equal(stale.status, 404);
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );

  it.effect("preflights the path prefix and never treats 403 as a bad credential", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(directory + "/index.html", "bundled");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      const state = { preflight: 403 as number | "false", rejected: 0 };
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        sourceSalt: "test-salt",
        serverOrigin: async () => new URL("https://studio.example/t3/"),
        serverAuthorization: async () => ({ authorization: "token", environmentId: "studio" }),
        noteAuthorizationRejected: async () => {
          state.rejected += 1;
        },
        clerkFrontendApiHostname: undefined,
      });
      netFetchMock.mockImplementation(async (url: string) => {
        if (String(url).endsWith("/api/auth/session")) {
          if (state.preflight === "false") return Response.json({ authenticated: false });
          return new Response("{}", { status: state.preflight });
        }
        return new Response("server", {
          headers: {
            "content-type": "text/html",
            "t3-desktop-ui-protocol": "1",
            "t3-desktop-bridge": "reduced-1",
          },
        });
      });
      const redirect = yield* Effect.promise(() =>
        handler!(navigation("t3code://app/?desktopWindowId=1")),
      );
      const pageUrl = redirect.headers.get("location")!;
      const accepted = yield* Effect.promise(() =>
        handler!(navigation(pageUrl, { headers: { accept: "text/html" } })),
      );
      assert.equal(accepted.status, 200);
      assert.equal(state.rejected, 0);
      const preflightCall = netFetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/api/auth/session"),
      );
      assert.isDefined(preflightCall);
      assert.equal(String(preflightCall[0]), "https://studio.example/t3/api/auth/session");
      assert.equal((preflightCall[1] as RequestInit).credentials, "omit");

      state.preflight = "false";
      yield* Effect.promise(() => handler!(navigation("t3code://app/?desktopWindowId=1")));
      const rejected = yield* Effect.promise(() =>
        handler!(navigation(pageUrl, { headers: { accept: "text/html" } })),
      );
      assert.equal(rejected.status, 302);
      assert.equal(new URL(rejected.headers.get("location")!).searchParams.get("auth"), "1");
      assert.equal(state.rejected, 1);
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );
  it("keeps the server-UI host stable for one install salt", () => {
    const origin = new URL("https://studio.example/");
    assert.equal(
      ElectronProtocol.serverUiSourceHost(7, origin, "install-salt"),
      ElectronProtocol.serverUiSourceHost(7, origin, "install-salt"),
    );
    assert.notEqual(
      ElectronProtocol.serverUiSourceHost(7, origin, "install-salt"),
      ElectronProtocol.serverUiSourceHost(7, origin, "other-salt"),
    );
  });

  it.effect("matches cookie paths with the origin prefix and a segment boundary", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(directory + "/index.html", "bundled");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        sourceSalt: "test-salt",
        serverOrigin: async () => new URL("https://studio.example/t3/"),
        serverAuthorization: async () => null,
        clerkFrontendApiHostname: undefined,
      });
      netFetchMock.mockImplementation(async () => {
        const headers = new Headers({
          "content-type": "text/html",
          "t3-desktop-ui-protocol": "1",
          "t3-desktop-bridge": "reduced-1",
        });
        headers.append("set-cookie", "session=abc; Path=/t3/; HttpOnly");
        headers.append("set-cookie", "api=yes; Path=/t3/api; HttpOnly");
        return new Response("server", { headers });
      });
      const redirect = yield* Effect.promise(() =>
        handler!(navigation("t3code://app/?desktopWindowId=1")),
      );
      const pageUrl = redirect.headers.get("location")!;
      yield* Effect.promise(() => handler!(navigation("t3code://app/?desktopWindowId=1")));
      yield* Effect.promise(() =>
        handler!(navigation(pageUrl, { headers: { accept: "text/html" } })),
      );
      const token = yield* protocol.serverUiRequestTokenFor(new URL(pageUrl).host);
      assert.ok(token);
      const cookieFor = (path: string) =>
        Effect.gen(function* () {
          netFetchMock.mockImplementation(async () => new Response("{}"));
          yield* Effect.promise(() =>
            handler!(
              new Request(new URL(path, pageUrl), {
                headers: { "sec-fetch-site": "same-origin", "x-t3-server-ui": token },
              }),
            ),
          );
          const headers = netFetchMock.mock.calls.at(-1)?.[1].headers as Headers;
          return headers.get("cookie") ?? "";
        });
      const apiCookies = yield* cookieFor("api/auth/session");
      assert.include(apiCookies, "session=abc");
      assert.include(apiCookies, "api=yes");
      const sibling = yield* cookieFor("apix");
      assert.include(sibling, "session=abc");
      assert.notInclude(sibling, "api=yes");
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );

  it.effect("drops a stale jar cookie that shadows the valid bearer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(directory + "/index.html", "bundled");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      let credential: { authorization: string; environmentId: string } | null = null;
      const rejected: Array<string> = [];
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        sourceSalt: "test-salt",
        serverOrigin: async () => new URL("https://studio.example/"),
        serverAuthorization: async () => credential,
        noteAuthorizationRejected: async (_origin, token) => {
          rejected.push(token);
        },
        clerkFrontendApiHostname: undefined,
      });
      let setCookie = true;
      netFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/api/auth/session")) {
          const headers = new Headers(init?.headers);
          return Response.json({
            authenticated:
              headers.get("authorization") === "Bearer good-token" &&
              headers.get("cookie") === null,
          });
        }
        const headers = new Headers({
          "content-type": "text/html",
          "t3-desktop-ui-protocol": "1",
          "t3-desktop-bridge": "reduced-1",
        });
        if (setCookie) headers.append("set-cookie", "session=stale; Path=/; HttpOnly");
        return new Response("server", { headers });
      });
      const redirect = yield* Effect.promise(() =>
        handler!(navigation("t3code://app/?desktopWindowId=1")),
      );
      const pageUrl = redirect.headers.get("location")!;
      yield* Effect.promise(() => handler!(navigation("t3code://app/?desktopWindowId=1")));
      yield* Effect.promise(() =>
        handler!(navigation(pageUrl, { headers: { accept: "text/html" } })),
      );

      credential = { authorization: "good-token", environmentId: "studio" };
      setCookie = false;
      const document = yield* Effect.promise(() =>
        handler!(navigation(pageUrl, { headers: { accept: "text/html" } })),
      );
      assert.equal(document.status, 200);
      assert.deepEqual(rejected, []);
      const token = yield* protocol.serverUiRequestTokenFor(new URL(pageUrl).host);
      assert.ok(token);
      const subresource = yield* Effect.promise(() =>
        handler!(
          new Request(new URL("api/thing", pageUrl), {
            headers: { "sec-fetch-site": "same-origin", "x-t3-server-ui": token },
          }),
        ),
      );
      assert.equal(subresource.status, 200);
      const forwarded = netFetchMock.mock.calls.at(-1)?.[1].headers as Headers;
      assert.equal(forwarded.get("authorization"), "Bearer good-token");
      assert.isNull(forwarded.get("cookie"));
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );
  it.effect("never injects credentials into a server-host subframe navigation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(directory + "/index.html", "bundled");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        sourceSalt: "test-salt",
        serverOrigin: async () => new URL("https://studio.example/"),
        serverAuthorization: async () => ({
          authorization: "owner-bearer",
          environmentId: "studio",
        }),
        clerkFrontendApiHostname: undefined,
      });
      netFetchMock.mockImplementation(async (url: string) => {
        if (String(url).endsWith("/api/auth/session")) {
          return Response.json({ authenticated: true });
        }
        if (String(url).includes("preview.html")) {
          return new Response("<html>preview</html>", {
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("server", {
          headers: {
            "content-type": "text/html",
            "t3-desktop-ui-protocol": "1",
            "t3-desktop-bridge": "reduced-1",
          },
        });
      });
      const redirect = yield* Effect.promise(() =>
        handler!(navigation("t3code://app/?desktopWindowId=1")),
      );
      const pageUrl = redirect.headers.get("location")!;
      yield* Effect.promise(() =>
        handler!(navigation(pageUrl, { headers: { accept: "text/html" } })),
      );
      const token = yield* protocol.serverUiRequestTokenFor(new URL(pageUrl).host);
      assert.ok(token);

      // A subframe POST cannot use the document branch and gets no credentials.
      const iframePost = yield* Effect.promise(() =>
        handler!(
          navigation(new URL("api/iframe", pageUrl).toString(), {
            method: "POST",
            headers: { "content-type": "text/plain", "sec-fetch-site": "cross-site" },
            body: "side effect",
          }),
        ),
      );
      assert.equal(iframePost.status, 403);
      assert.isFalse(netFetchMock.mock.calls.some(([url]) => String(url).includes("/api/iframe")));

      // A subframe navigation without the UI headers must not redirect or clear the source.
      const iframePage = yield* Effect.promise(() =>
        handler!(
          navigation(new URL("preview.html", pageUrl).toString(), {
            headers: { accept: "text/html", "sec-fetch-site": "same-origin" },
          }),
        ),
      );
      assert.equal(iframePage.status, 200);
      const forwarded = yield* Effect.promise(() =>
        handler!(
          new Request(new URL("api/thing", pageUrl), {
            headers: { "sec-fetch-site": "same-origin", "x-t3-server-ui": token },
          }),
        ),
      );
      assert.equal(forwarded.status, 200);
      const mainSubresource = netFetchMock.mock.calls.at(-1)?.[1].headers as Headers;
      assert.equal(mainSubresource.get("authorization"), "Bearer owner-bearer");
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );
  it.effect("does not evict a live source for a forged server-host navigation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(directory + "/index.html", "bundled");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        sourceSalt: "test-salt",
        serverOrigin: async () => new URL("https://studio.example/"),
        serverAuthorization: async () => ({
          authorization: "owner-bearer",
          environmentId: "studio",
        }),
        clerkFrontendApiHostname: undefined,
      });
      netFetchMock.mockImplementation(async (url: string) => {
        if (String(url).endsWith("/api/auth/session"))
          return Response.json({ authenticated: true });
        return new Response("server", {
          headers: {
            "content-type": "text/html",
            "t3-desktop-ui-protocol": "1",
            "t3-desktop-bridge": "reduced-1",
          },
        });
      });
      const redirect = yield* Effect.promise(() =>
        handler!(navigation("t3code://app/?desktopWindowId=1")),
      );
      const pageUrl = redirect.headers.get("location")!;
      yield* Effect.promise(() =>
        handler!(navigation(pageUrl, { headers: { accept: "text/html" } })),
      );
      const forged = yield* Effect.promise(() =>
        handler!(navigation(`t3code://server-1-${"f".repeat(24)}/`)),
      );
      assert.equal(forged.status, 404);
      const token = yield* protocol.serverUiRequestTokenFor(new URL(pageUrl).host);
      assert.ok(token);
      const live = yield* Effect.promise(() =>
        handler!(
          new Request(new URL("api/thing", pageUrl), {
            headers: { "sec-fetch-site": "same-origin", "x-t3-server-ui": token },
          }),
        ),
      );
      assert.equal(live.status, 200);
      const forwarded = netFetchMock.mock.calls.at(-1)?.[1].headers as Headers;
      assert.equal(forwarded.get("authorization"), "Bearer owner-bearer");
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );
});
