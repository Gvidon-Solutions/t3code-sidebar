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
      yield* Effect.promise(() => handler!(new Request(new URL("assets/old.js", studioPage))));
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
            headers: { accept: "text/html" },
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
});
