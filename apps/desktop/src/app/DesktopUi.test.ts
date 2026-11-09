import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as Catalog from "./DesktopConnectionCatalogStore.ts";
import * as Exposure from "../backend/DesktopServerExposure.ts";
import { make } from "./DesktopUi.ts";

const studio = {
  environmentId: EnvironmentId.make("studio"),
  httpBaseUrl: "https://studio.example",
  serverVersion: "2",
};
const cloudbox = {
  environmentId: EnvironmentId.make("cloudbox"),
  httpBaseUrl: "https://cloudbox.example",
  serverVersion: "3",
};

describe("Desktop connected UI source", () => {
  it.effect(
    "authorizes paired origins, switches source and version, restores selection and retains bundled fallback",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped();
        const raw = yield* Ref.make(
          JSON.stringify({
            schemaVersion: 1,
            targets: [
              ...[studio, cloudbox].map((entry) => ({
                _tag: "BearerConnectionTarget",
                connectionId: entry.environmentId,
                environmentId: entry.environmentId,
                label: entry.environmentId,
              })),
              { _tag: "RelayConnectionTarget", environmentId: "relay-only", label: "Relay" },
            ],
            profiles: [studio, cloudbox].map((entry) => ({
              _tag: "BearerConnectionProfile",
              connectionId: entry.environmentId,
              environmentId: entry.environmentId,
              label: entry.environmentId,
              httpBaseUrl: entry.httpBaseUrl,
              wsBaseUrl: entry.httpBaseUrl.replace("https", "wss"),
            })),
            credentials: [],
            remoteDpopTokens: [],
            disabledEnvironmentIds: [],
          }),
        );
        const program = Effect.gen(function* () {
          const ui = yield* make;
          expect(yield* ui.select(studio)).toBe(true);
          expect(yield* ui.selectionLabel).toBe("studio");
          expect(yield* ui.connectionOrigins).toEqual([
            "https://studio.example",
            "https://cloudbox.example",
          ]);
          yield* ui.recordSource(new URL(studio.httpBaseUrl));
          expect((yield* ui.getInfo).version).toBe("2");
          expect(yield* ui.select(cloudbox)).toBe(true);
          expect((yield* ui.getInfo).version).toBe("2");
          yield* ui.recordSource(new URL(cloudbox.httpBaseUrl));
          expect(yield* ui.getInfo).toMatchObject({
            source: "server",
            origin: "https://cloudbox.example/",
            version: "3",
            shellVersion: "1",
          });
          expect(yield* ui.select(cloudbox)).toBe(false);
          for (const httpBaseUrl of [
            "https://intruder.example",
            "http://studio.example",
            "file:///tmp/app",
            "https://user:secret@studio.example",
          ]) {
            expect((yield* ui.select({ ...studio, httpBaseUrl }).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
          }
          expect(
            (yield* ui
              .select({ ...studio, environmentId: EnvironmentId.make("unknown") })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          const restored = yield* make;
          expect(yield* restored.selection).toEqual(cloudbox);
          yield* restored.recordSource(null, "offline");
          expect(yield* restored.getInfo).toMatchObject({
            source: "bundled",
            origin: null,
            version: "1",
            reason: "offline",
          });
          expect(
            yield* restored.select({
              environmentId: EnvironmentId.make("relay-only"),
              httpBaseUrl: "https://relay.example",
              serverVersion: "4",
            }),
          ).toBe(true);
          expect((yield* restored.selection)?.httpBaseUrl).toBeNull();
          yield* restored.recordSource(null);
          expect((yield* restored.getInfo).reason).toContain("no direct UI route");
          yield* fs.writeFileString(
            stateDir + "/ui-source.json",
            JSON.stringify({
              environmentId: "relay-only",
              httpBaseUrl: "https://intruder.example",
              serverVersion: "4",
            }),
          );
          const relayRestored = yield* make;
          expect((yield* relayRestored.selection)?.httpBaseUrl).toBeNull();
          yield* Ref.set(
            raw,
            JSON.stringify({
              ...JSON.parse(yield* Ref.get(raw)),
              disabledEnvironmentIds: ["studio"],
            }),
          );
          expect((yield* restored.select(studio).pipe(Effect.result))._tag).toBe("Failure");
        });
        yield* program.pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
            stateDir,
            appVersion: "1",
            isDevelopment: false,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
          Effect.provideService(
            Catalog.DesktopConnectionCatalogStore,
            Catalog.DesktopConnectionCatalogStore.of({
              get: Ref.get(raw).pipe(Effect.asSome),
              set: () => Effect.succeed(true),
            }),
          ),
          Effect.provideService(Exposure.DesktopServerExposure, {
            backendConfig: Effect.succeed({ port: 0, httpBaseUrl: new URL("http://127.0.0.1") }),
          } as Exposure.DesktopServerExposure["Service"]),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("keeps the server UI credential in memory and downgrades a rejected one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const raw = yield* Ref.make(
        JSON.stringify({
          schemaVersion: 1,
          targets: [studio, cloudbox].map((entry) => ({
            _tag: "BearerConnectionTarget",
            connectionId: entry.environmentId,
            environmentId: entry.environmentId,
            label: entry.environmentId,
          })),
          profiles: [
            {
              _tag: "BearerConnectionProfile",
              connectionId: studio.environmentId,
              environmentId: studio.environmentId,
              label: studio.environmentId,
              httpBaseUrl: studio.httpBaseUrl,
              wsBaseUrl: "wss://studio.example",
            },
            {
              _tag: "BearerConnectionProfile",
              connectionId: cloudbox.environmentId,
              environmentId: cloudbox.environmentId,
              label: cloudbox.environmentId,
              httpBaseUrl: cloudbox.httpBaseUrl,
              wsBaseUrl: "wss://cloudbox.example",
            },
          ],
          credentials: [],
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      );
      const program = Effect.gen(function* () {
        const ui = yield* make;
        expect(yield* ui.select({ ...studio, authorization: "token-a" })).toBe(true);
        const origin = new URL(studio.httpBaseUrl + "/");
        expect(yield* ui.serverAuthorization(origin)).toBe("token-a");
        const persisted = yield* fs.readFileString(stateDir + "/ui-source.json");
        expect(persisted).not.toContain("token-a");

        yield* ui.noteAuthorizationRejected(origin, "token-a");
        expect(yield* ui.serverAuthorization(origin)).toBeNull();
        expect((yield* ui.getInfo).reason).toContain("authentication");

        expect(yield* ui.select({ ...studio, authorization: "token-a" })).toBe(true);
        expect((yield* ui.selection)?.httpBaseUrl).toBeNull();

        expect(yield* ui.select({ ...studio, authorization: "token-b" })).toBe(true);
        expect((yield* ui.selection)?.httpBaseUrl).toBe(studio.httpBaseUrl);
        expect(yield* ui.serverAuthorization(origin)).toBe("token-b");

        expect(yield* ui.select(studio)).toBe(false);
        expect(yield* ui.serverAuthorization(origin)).toBe("token-b");

        // A reduced server UI switch carries no credential; hop through the trusted client.
        expect(
          yield* ui.select({ ...cloudbox, serverVersion: "3" }, { trustedClient: false }),
        ).toBe(true);
        expect((yield* ui.selection)?.httpBaseUrl).toBeNull();
        expect(
          yield* ui.select({ ...cloudbox, serverVersion: "3", authorization: "cloudbox-token" }),
        ).toBe(true);
        expect((yield* ui.selection)?.httpBaseUrl).toBe(cloudbox.httpBaseUrl);
      });
      yield* program.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          stateDir,
          appVersion: "1",
          isDevelopment: false,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(
          Catalog.DesktopConnectionCatalogStore,
          Catalog.DesktopConnectionCatalogStore.of({
            get: Ref.get(raw).pipe(Effect.asSome),
            set: () => Effect.succeed(true),
          }),
        ),
        Effect.provideService(Exposure.DesktopServerExposure, {
          backendConfig: Effect.succeed({ port: 0, httpBaseUrl: new URL("http://127.0.0.1") }),
        } as Exposure.DesktopServerExposure["Service"]),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
