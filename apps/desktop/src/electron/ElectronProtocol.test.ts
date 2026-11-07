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
        Effect.promise(() => handler!(new Request(`t3code://app${pathname}`, init)));

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
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        serverOrigin: async () => desiredOrigin,
        clerkFrontendApiHostname: undefined,
      });
      const page = () =>
        Effect.promise(() =>
          handler!(
            new Request("t3code://app/", {
              headers: {
                accept: "text/html",
                cookie: "local=secret",
                authorization: "Bearer local-secret",
              },
            }),
          ),
        );
      netFetchMock.mockImplementation(
        async () =>
          new Response("server-v1", {
            headers: { "content-type": "text/html", "set-cookie": "remote=secret" },
          }),
      );
      const first = yield* page();
      assert.equal(yield* Effect.promise(() => first.text()), "server-v1");
      assert.equal(netFetchMock.mock.calls.at(-1)?.[0], "https://studio.example/prefix/");
      const forwardedHeaders = netFetchMock.mock.calls.at(-1)?.[1].headers as Headers;
      assert.isFalse(forwardedHeaders.has("cookie"));
      assert.isFalse(forwardedHeaders.has("authorization"));
      assert.isNull(first.headers.get("set-cookie"));
      assert.isNull(first.headers.get("content-encoding"));
      assert.isNull(first.headers.get("content-length"));
      desiredOrigin = new URL("https://cloudbox.example/");
      yield* Effect.promise(() => handler!(new Request("t3code://app/assets/old.js")));
      assert.equal(
        netFetchMock.mock.calls.at(-1)?.[0],
        "https://studio.example/prefix/assets/old.js",
      );
      netFetchMock.mockImplementation(
        async () => new Response("server-v2", { headers: { "content-type": "text/html" } }),
      );
      const second = yield* page();
      assert.equal(yield* Effect.promise(() => second.text()), "server-v2");
      assert.equal(netFetchMock.mock.calls.at(-1)?.[0], "https://cloudbox.example/");
      netFetchMock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
      const offline = yield* page();
      assert.equal(yield* Effect.promise(() => offline.text()), "bundled");
      netFetchMock.mockImplementation(
        async () => new Response("server-v3", { headers: { "content-type": "text/html" } }),
      );
      const recovered = yield* page();
      assert.equal(yield* Effect.promise(() => recovered.text()), "server-v3");
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );
});
