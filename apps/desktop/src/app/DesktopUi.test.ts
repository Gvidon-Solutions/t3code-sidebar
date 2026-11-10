import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as Catalog from "./DesktopConnectionCatalogStore.ts";
import * as Exposure from "../backend/DesktopServerExposure.ts";
import * as LocalAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as TestClock from "effect/testing/TestClock";
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
            credentials: [studio, cloudbox].map((entry) => ({
              connectionId: entry.environmentId,
              credential: {
                _tag: "BearerConnectionCredential",
                token: `token-${entry.environmentId}`,
              },
            })),
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
          // A disabled saved connection still answers the selection, but only with the
          // bundled source; it can never gate a server document.
          expect(yield* restored.select(studio)).toBe(false);
          expect((yield* restored.selection)?.httpBaseUrl).toBeNull();
          expect(yield* restored.sourceOrigin).toBeNull();
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
          Effect.provideService(LocalAuth.DesktopLocalEnvironmentAuth, {
            getBearerToken: Effect.fail(
              new LocalAuth.DesktopLocalEnvironmentAuthBackendNotConfiguredError(),
            ),
          } as unknown as LocalAuth.DesktopLocalEnvironmentAuth["Service"]),
          Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
            activeEnvironments: Effect.succeed([]),
          } as unknown as DesktopSshEnvironment.DesktopSshEnvironment["Service"]),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("reads credentials from the shell catalog, retries rejections and hops safely", () =>
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
          profiles: [studio, cloudbox].map((entry) => ({
            _tag: "BearerConnectionProfile",
            connectionId: entry.environmentId,
            environmentId: entry.environmentId,
            label: entry.environmentId,
            httpBaseUrl: entry.httpBaseUrl,
            wsBaseUrl: entry.httpBaseUrl.replace("https", "wss"),
          })),
          credentials: [
            {
              connectionId: studio.environmentId,
              credential: { _tag: "BearerConnectionCredential", token: "token-a" },
            },
            {
              connectionId: cloudbox.environmentId,
              credential: { _tag: "BearerConnectionCredential", token: "cloudbox-token" },
            },
          ],
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      );
      const program = Effect.gen(function* () {
        const ui = yield* make;
        expect(yield* ui.select(studio)).toBe(true);
        const origin = new URL(studio.httpBaseUrl + "/");
        expect(yield* ui.serverAuthorization(origin)).toEqual({
          authorization: "token-a",
          environmentId: studio.environmentId,
        });
        expect(yield* ui.sourceOrigin).toEqual(origin);
        const persisted = yield* fs.readFileString(stateDir + "/ui-source.json");
        expect(persisted).not.toContain("token-a");

        yield* ui.noteAuthorizationRejected(origin, "token-a");
        expect(yield* ui.serverAuthorization(origin)).not.toBeNull();
        expect((yield* ui.getInfo).reason).toContain("authentication");
        yield* ui.noteAuthorizationRejected(origin, "token-a");
        expect(yield* ui.serverAuthorization(origin)).toBeNull();
        expect(yield* ui.sourceOrigin).toBeNull();
        expect(yield* ui.select(studio)).toBe(true);
        expect((yield* ui.selection)?.httpBaseUrl).toBeNull();

        yield* TestClock.adjust("2 minutes");
        expect(yield* ui.serverAuthorization(origin)).not.toBeNull();
        expect(yield* ui.select(studio)).toBe(true);
        expect((yield* ui.selection)?.httpBaseUrl).toBe(studio.httpBaseUrl);

        yield* ui.noteAuthorizationRejected(origin, "token-a");
        yield* ui.noteAuthorizationRejected(origin, "token-a");
        yield* ui.retryServerUi;
        expect(yield* ui.serverAuthorization(origin)).not.toBeNull();
        expect(yield* ui.select(studio)).toBe(false);
        expect((yield* ui.selection)?.httpBaseUrl).toBe(studio.httpBaseUrl);
        expect(yield* ui.sourceOrigin).toEqual(origin);

        // A reduced server UI cannot move the shell's persisted selection, and its
        // own origin keeps its credential while another window selects elsewhere.
        expect(
          yield* ui.select({ ...cloudbox, serverVersion: "3" }, { trustedClient: false }),
        ).toBe(false);
        expect((yield* ui.selection)?.httpBaseUrl).toBe(studio.httpBaseUrl);
        expect(yield* ui.serverAuthorization(origin)).not.toBeNull();
        expect(yield* ui.select({ ...cloudbox, serverVersion: "3" })).toBe(true);
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
        Effect.provideService(LocalAuth.DesktopLocalEnvironmentAuth, {
          getBearerToken: Effect.fail(
            new LocalAuth.DesktopLocalEnvironmentAuthBackendNotConfiguredError(),
          ),
        } as unknown as LocalAuth.DesktopLocalEnvironmentAuth["Service"]),
        Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
          activeEnvironments: Effect.succeed([]),
        } as unknown as DesktopSshEnvironment.DesktopSshEnvironment["Service"]),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restores a persisted server UI only when the shell still has a credential", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        stateDir + "/ui-source.json",
        JSON.stringify({
          environmentId: "studio",
          httpBaseUrl: studio.httpBaseUrl,
          serverVersion: "2",
        }),
      );
      const withCredential = yield* Ref.make(
        JSON.stringify({
          schemaVersion: 1,
          targets: [
            {
              _tag: "BearerConnectionTarget",
              connectionId: "studio",
              environmentId: "studio",
              label: "studio",
            },
          ],
          profiles: [
            {
              _tag: "BearerConnectionProfile",
              connectionId: "studio",
              environmentId: "studio",
              label: "studio",
              httpBaseUrl: studio.httpBaseUrl,
              wsBaseUrl: "wss://studio.example",
            },
          ],
          credentials: [
            {
              connectionId: "studio",
              credential: { _tag: "BearerConnectionCredential", token: "token-a" },
            },
          ],
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      );
      const withoutCredential = yield* Ref.make(
        JSON.stringify({
          schemaVersion: 1,
          targets: [
            {
              _tag: "BearerConnectionTarget",
              connectionId: "studio",
              environmentId: "studio",
              label: "studio",
            },
          ],
          profiles: [
            {
              _tag: "BearerConnectionProfile",
              connectionId: "studio",
              environmentId: "studio",
              label: "studio",
              httpBaseUrl: studio.httpBaseUrl,
              wsBaseUrl: "wss://studio.example",
            },
          ],
          credentials: [],
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      );
      const provide = (raw: Ref.Ref<string>) =>
        Effect.provideService(
          Catalog.DesktopConnectionCatalogStore,
          Catalog.DesktopConnectionCatalogStore.of({
            get: Ref.get(raw).pipe(Effect.asSome),
            set: () => Effect.succeed(true),
          }),
        );
      const base = Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        stateDir,
        appVersion: "1",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const exposure = Effect.provideService(Exposure.DesktopServerExposure, {
        backendConfig: Effect.succeed({ port: 0, httpBaseUrl: new URL("http://127.0.0.1") }),
      } as Exposure.DesktopServerExposure["Service"]);
      const local = Effect.provideService(LocalAuth.DesktopLocalEnvironmentAuth, {
        getBearerToken: Effect.fail(
          new LocalAuth.DesktopLocalEnvironmentAuthBackendNotConfiguredError(),
        ),
      } as unknown as LocalAuth.DesktopLocalEnvironmentAuth["Service"]);
      const ssh = Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
        activeEnvironments: Effect.succeed([]),
      } as unknown as DesktopSshEnvironment.DesktopSshEnvironment["Service"]);

      const restored = yield* make.pipe(base, provide(withCredential), exposure, local, ssh);
      expect((yield* restored.selection)?.httpBaseUrl).toBe(studio.httpBaseUrl);
      expect(yield* restored.serverAuthorization(new URL(studio.httpBaseUrl + "/"))).toEqual({
        authorization: "token-a",
        environmentId: studio.environmentId,
      });

      const uncredentialed = yield* make.pipe(
        base,
        provide(withoutCredential),
        exposure,
        local,
        ssh,
      );
      expect((yield* uncredentialed.selection)?.httpBaseUrl).toBeNull();
      expect(yield* uncredentialed.sourceOrigin).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("keys credentials by environment and origin and drops a removed credential", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const shared = "https://shared.example";
      const raw = yield* Ref.make(
        JSON.stringify({
          schemaVersion: 1,
          targets: [studio, cloudbox].map((entry) => ({
            _tag: "BearerConnectionTarget",
            connectionId: entry.environmentId,
            environmentId: entry.environmentId,
            label: entry.environmentId,
          })),
          profiles: [studio, cloudbox].map((entry) => ({
            _tag: "BearerConnectionProfile",
            connectionId: entry.environmentId,
            environmentId: entry.environmentId,
            label: entry.environmentId,
            httpBaseUrl: shared,
            wsBaseUrl: "wss://shared.example",
          })),
          credentials: [
            {
              connectionId: studio.environmentId,
              credential: { _tag: "BearerConnectionCredential", token: "studio-token" },
            },
            {
              connectionId: cloudbox.environmentId,
              credential: { _tag: "BearerConnectionCredential", token: "cloudbox-token" },
            },
          ],
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      );
      const ui = yield* make.pipe(
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
        Effect.provideService(LocalAuth.DesktopLocalEnvironmentAuth, {
          getBearerToken: Effect.fail(
            new LocalAuth.DesktopLocalEnvironmentAuthBackendNotConfiguredError(),
          ),
        } as unknown as LocalAuth.DesktopLocalEnvironmentAuth["Service"]),
        Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
          activeEnvironments: Effect.succeed([]),
        } as unknown as DesktopSshEnvironment.DesktopSshEnvironment["Service"]),
      );
      const origin = new URL(shared + "/");
      expect(yield* ui.select({ ...studio, httpBaseUrl: shared })).toBe(true);
      expect(yield* ui.serverAuthorization(origin)).toEqual({
        authorization: "studio-token",
        environmentId: studio.environmentId,
      });
      expect(yield* ui.select({ ...cloudbox, httpBaseUrl: shared })).toBe(true);
      expect(yield* ui.serverAuthorization(origin)).toEqual({
        authorization: "cloudbox-token",
        environmentId: cloudbox.environmentId,
      });
      yield* Ref.set(
        raw,
        JSON.stringify({
          ...JSON.parse(yield* Ref.get(raw)),
          credentials: [
            {
              connectionId: studio.environmentId,
              credential: { _tag: "BearerConnectionCredential", token: "studio-token" },
            },
          ],
        }),
      );
      expect(yield* ui.serverAuthorization(origin)).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("releases an SSH credential only for its live tunnel target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const origin = "http://127.0.0.1:4022";
      const sshTarget = { alias: "studio-ssh", hostname: "10.0.0.5", username: "dev", port: 22 };
      const raw = yield* Ref.make(
        JSON.stringify({
          schemaVersion: 1,
          targets: [
            {
              _tag: "SshConnectionTarget",
              connectionId: "ssh-1",
              environmentId: "cloudbox",
              label: "cloudbox",
            },
          ],
          profiles: [
            {
              _tag: "SshConnectionProfile",
              connectionId: "ssh-1",
              environmentId: "cloudbox",
              label: "cloudbox",
              target: sshTarget,
            },
          ],
          credentials: [
            {
              connectionId: "ssh-1",
              credential: { _tag: "BearerConnectionCredential", token: "ssh-token" },
            },
          ],
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      );
      const tunnels = yield* Ref.make([
        {
          key: "ssh-1",
          target: sshTarget,
          httpBaseUrl: origin + "/",
          wsBaseUrl: "ws://127.0.0.1:4022/",
        },
      ]);
      const ui = yield* make.pipe(
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
        Effect.provideService(LocalAuth.DesktopLocalEnvironmentAuth, {
          getBearerToken: Effect.fail(
            new LocalAuth.DesktopLocalEnvironmentAuthBackendNotConfiguredError(),
          ),
        } as unknown as LocalAuth.DesktopLocalEnvironmentAuth["Service"]),
        Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
          activeEnvironments: Ref.get(tunnels),
        } as unknown as DesktopSshEnvironment.DesktopSshEnvironment["Service"]),
      );
      expect(
        yield* ui.select({
          environmentId: cloudbox.environmentId,
          httpBaseUrl: origin,
          serverVersion: "2",
        }),
      ).toBe(true);
      expect(yield* ui.serverAuthorization(new URL(origin + "/"))).toEqual({
        authorization: "ssh-token",
        environmentId: cloudbox.environmentId,
      });
      yield* Ref.set(tunnels, [
        {
          key: "ssh-1",
          target: { ...sshTarget, hostname: "10.0.0.6" },
          httpBaseUrl: origin + "/",
          wsBaseUrl: "ws://127.0.0.1:4022/",
        },
      ]);
      expect(yield* ui.serverAuthorization(new URL(origin + "/"))).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the server UI only when it is strictly newer than the bundled client", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const raw = yield* Ref.make(
        JSON.stringify({
          schemaVersion: 1,
          targets: [
            {
              _tag: "BearerConnectionTarget",
              connectionId: "studio",
              environmentId: "studio",
              label: "studio",
            },
          ],
          profiles: [
            {
              _tag: "BearerConnectionProfile",
              connectionId: "studio",
              environmentId: "studio",
              label: "studio",
              httpBaseUrl: studio.httpBaseUrl,
              wsBaseUrl: "wss://studio.example",
            },
          ],
          credentials: [
            {
              connectionId: "studio",
              credential: { _tag: "BearerConnectionCredential", token: "token-a" },
            },
          ],
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      );
      const makeUi = (stateDir: string) =>
        make.pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
            stateDir,
            appVersion: "0.1.6",
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
          Effect.provideService(LocalAuth.DesktopLocalEnvironmentAuth, {
            getBearerToken: Effect.fail(
              new LocalAuth.DesktopLocalEnvironmentAuthBackendNotConfiguredError(),
            ),
          } as unknown as LocalAuth.DesktopLocalEnvironmentAuth["Service"]),
          Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
            activeEnvironments: Effect.succeed([]),
          } as unknown as DesktopSshEnvironment.DesktopSshEnvironment["Service"]),
        );

      const cases = [
        { version: "0.1.7", serverUi: true },
        { version: "0.1.6", serverUi: false },
        { version: "0.1.5", serverUi: false },
        { version: "studio-1", serverUi: false },
        { version: "", serverUi: false },
      ] as const;
      for (const [index, entry] of cases.entries()) {
        const stateDir = `${root}/${index}`;
        yield* fs.makeDirectory(stateDir, { recursive: true });
        yield* fs.writeFileString(
          `${stateDir}/ui-source.json`,
          JSON.stringify({
            environmentId: "studio",
            httpBaseUrl: studio.httpBaseUrl,
            serverVersion: entry.version,
          }),
        );
        const ui = yield* makeUi(stateDir);
        expect((yield* ui.selection)?.httpBaseUrl, entry.version).toBe(
          entry.serverUi ? studio.httpBaseUrl : null,
        );
        const sourceOrigin = yield* ui.sourceOrigin;
        expect(sourceOrigin, entry.version).toEqual(
          entry.serverUi ? new URL(studio.httpBaseUrl + "/") : null,
        );
        yield* ui.recordSource(sourceOrigin);
        expect((yield* ui.getInfo).source, entry.version).toBe(
          entry.serverUi ? "server" : "bundled",
        );
      }

      const selectDir = `${root}/select`;
      const selectable = yield* makeUi(selectDir);
      expect(
        yield* selectable.select({
          environmentId: studio.environmentId,
          httpBaseUrl: studio.httpBaseUrl,
          serverVersion: "0.1.6",
        }),
      ).toBe(false);
      expect((yield* selectable.selection)?.httpBaseUrl).toBeNull();
      expect(yield* selectable.serverAuthorization(new URL(studio.httpBaseUrl + "/"))).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never serves a disabled or unknown environment, or the local backend while off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const entries = [
        { environmentId: "studio", httpBaseUrl: "https://studio.example", disabled: false },
        { environmentId: "cloudbox", httpBaseUrl: "https://cloudbox.example", disabled: false },
        { environmentId: "atlas", httpBaseUrl: "http://127.0.0.1:4080", disabled: true },
      ];
      const raw = yield* Ref.make(
        JSON.stringify({
          schemaVersion: 1,
          targets: entries.map((entry) => ({
            _tag: "BearerConnectionTarget",
            connectionId: entry.environmentId,
            environmentId: entry.environmentId,
            label: entry.environmentId,
          })),
          profiles: entries.map((entry) => ({
            _tag: "BearerConnectionProfile",
            connectionId: entry.environmentId,
            environmentId: entry.environmentId,
            label: entry.environmentId,
            httpBaseUrl: entry.httpBaseUrl,
            wsBaseUrl: entry.httpBaseUrl.replace("https", "wss"),
          })),
          credentials: entries.map((entry) => ({
            connectionId: entry.environmentId,
            credential: {
              _tag: "BearerConnectionCredential",
              token: `token-${entry.environmentId}`,
            },
          })),
          remoteDpopTokens: [],
          disabledEnvironmentIds: ["atlas"],
        }),
      );
      const ui = yield* make.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          stateDir,
          appVersion: "0.1.6",
          isDevelopment: false,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(
          Catalog.DesktopConnectionCatalogStore,
          Catalog.DesktopConnectionCatalogStore.of({
            get: Ref.get(raw).pipe(Effect.asSome),
            set: () => Effect.succeed(true),
          }),
        ),
        // The local backend is off: this is the live Windows desktop's setup.
        Effect.provideService(Exposure.DesktopServerExposure, {
          backendConfig: Effect.succeed({ port: 0, httpBaseUrl: new URL("http://127.0.0.1") }),
        } as Exposure.DesktopServerExposure["Service"]),
        Effect.provideService(LocalAuth.DesktopLocalEnvironmentAuth, {
          getBearerToken: Effect.fail(
            new LocalAuth.DesktopLocalEnvironmentAuthBackendNotConfiguredError(),
          ),
        } as unknown as LocalAuth.DesktopLocalEnvironmentAuth["Service"]),
        Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
          activeEnvironments: Effect.succeed([]),
        } as unknown as DesktopSshEnvironment.DesktopSshEnvironment["Service"]),
      );

      for (const selection of [
        {
          environmentId: EnvironmentId.make("atlas"),
          httpBaseUrl: "http://127.0.0.1:4080/",
        },
        {
          environmentId: EnvironmentId.make("unknown-machine"),
          httpBaseUrl: "https://unknown.example/",
        },
        {
          environmentId: EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID),
          httpBaseUrl: "http://127.0.0.1:3774/",
        },
      ]) {
        expect(
          yield* ui.select({ ...selection, serverVersion: "0.1.7" }),
          selection.environmentId,
        ).toBe(false);
        expect((yield* ui.selection)?.environmentId, selection.environmentId).toBe(
          selection.environmentId,
        );
        expect((yield* ui.selection)?.httpBaseUrl, selection.environmentId).toBeNull();
        expect(yield* ui.sourceOrigin, selection.environmentId).toBeNull();
        expect((yield* ui.getInfo).source, selection.environmentId).toBe("bundled");
      }

      // A persisted disabled source also restores as the bundled client, not an error.
      yield* fs.writeFileString(
        stateDir + "/ui-source.json",
        JSON.stringify({
          environmentId: "atlas",
          httpBaseUrl: "http://127.0.0.1:4080/",
          serverVersion: "0.1.7",
        }),
      );
      const restored = yield* make.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          stateDir,
          appVersion: "0.1.6",
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
        Effect.provideService(LocalAuth.DesktopLocalEnvironmentAuth, {
          getBearerToken: Effect.fail(
            new LocalAuth.DesktopLocalEnvironmentAuthBackendNotConfiguredError(),
          ),
        } as unknown as LocalAuth.DesktopLocalEnvironmentAuth["Service"]),
        Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
          activeEnvironments: Effect.succeed([]),
        } as unknown as DesktopSshEnvironment.DesktopSshEnvironment["Service"]),
      );
      expect((yield* restored.selection)?.httpBaseUrl).toBeNull();
      expect(yield* restored.sourceOrigin).toBeNull();
      expect((yield* restored.getInfo).source).toBe("bundled");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not reload for a bundled-only environment switch", () =>
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
          profiles: [studio, cloudbox].map((entry) => ({
            _tag: "BearerConnectionProfile",
            connectionId: entry.environmentId,
            environmentId: entry.environmentId,
            label: entry.environmentId,
            httpBaseUrl: entry.httpBaseUrl,
            wsBaseUrl: entry.httpBaseUrl.replace("https", "wss"),
          })),
          credentials: [studio, cloudbox].map((entry) => ({
            connectionId: entry.environmentId,
            credential: {
              _tag: "BearerConnectionCredential",
              token: `token-${entry.environmentId}`,
            },
          })),
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      );
      const ui = yield* make.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          stateDir,
          appVersion: "0.1.6",
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
        Effect.provideService(LocalAuth.DesktopLocalEnvironmentAuth, {
          getBearerToken: Effect.fail(
            new LocalAuth.DesktopLocalEnvironmentAuthBackendNotConfiguredError(),
          ),
        } as unknown as LocalAuth.DesktopLocalEnvironmentAuth["Service"]),
        Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
          activeEnvironments: Effect.succeed([]),
        } as unknown as DesktopSshEnvironment.DesktopSshEnvironment["Service"]),
      );
      expect(
        yield* ui.select({
          environmentId: studio.environmentId,
          httpBaseUrl: null,
          serverVersion: "0.1.6",
        }),
      ).toBe(false);
      expect((yield* ui.selection)?.environmentId).toBe(studio.environmentId);
      expect((yield* ui.selection)?.httpBaseUrl).toBeNull();
      expect(
        yield* ui.select({
          environmentId: cloudbox.environmentId,
          httpBaseUrl: null,
          serverVersion: "0.1.6",
        }),
      ).toBe(false);
      expect((yield* ui.selection)?.environmentId).toBe(cloudbox.environmentId);
      expect((yield* ui.selection)?.httpBaseUrl).toBeNull();
      expect(
        yield* ui.select({
          environmentId: cloudbox.environmentId,
          httpBaseUrl: cloudbox.httpBaseUrl,
          serverVersion: "0.1.7",
        }),
      ).toBe(true);
      expect((yield* ui.selection)?.httpBaseUrl).toBe(cloudbox.httpBaseUrl);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a server UI credential per source origin across windows", () =>
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
          profiles: [studio, cloudbox].map((entry) => ({
            _tag: "BearerConnectionProfile",
            connectionId: entry.environmentId,
            environmentId: entry.environmentId,
            label: entry.environmentId,
            httpBaseUrl: entry.httpBaseUrl,
            wsBaseUrl: entry.httpBaseUrl.replace("https", "wss"),
          })),
          credentials: [studio, cloudbox].map((entry) => ({
            connectionId: entry.environmentId,
            credential: {
              _tag: "BearerConnectionCredential",
              token: `token-${entry.environmentId}`,
            },
          })),
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      );
      const ui = yield* make.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          stateDir,
          appVersion: "0.1.6",
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
        Effect.provideService(LocalAuth.DesktopLocalEnvironmentAuth, {
          getBearerToken: Effect.fail(
            new LocalAuth.DesktopLocalEnvironmentAuthBackendNotConfiguredError(),
          ),
        } as unknown as LocalAuth.DesktopLocalEnvironmentAuth["Service"]),
        Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
          activeEnvironments: Effect.succeed([]),
        } as unknown as DesktopSshEnvironment.DesktopSshEnvironment["Service"]),
      );
      expect(yield* ui.select(studio)).toBe(true);
      const studioOrigin = new URL(studio.httpBaseUrl + "/");
      expect(yield* ui.serverAuthorization(studioOrigin)).toEqual({
        authorization: "token-studio",
        environmentId: studio.environmentId,
      });

      // Window 2 moves the shell to the bundled client; window 1 keeps its credential.
      expect(
        yield* ui.select({
          environmentId: cloudbox.environmentId,
          httpBaseUrl: null,
          serverVersion: "0.1.6",
        }),
      ).toBe(true);
      expect(yield* ui.sourceOrigin).toBeNull();
      expect(yield* ui.serverAuthorization(studioOrigin)).toEqual({
        authorization: "token-studio",
        environmentId: studio.environmentId,
      });

      // An untrusted window refreshes only its own origin, never the shell selection.
      expect(yield* ui.select(studio, { trustedClient: false })).toBe(false);
      expect((yield* ui.selection)?.environmentId).toBe(cloudbox.environmentId);
      expect((yield* ui.selection)?.httpBaseUrl).toBeNull();
      expect(yield* ui.serverAuthorization(studioOrigin)).toEqual({
        authorization: "token-studio",
        environmentId: studio.environmentId,
      });

      // Its own server becoming not-newer withdraws that window's credential only.
      expect(
        yield* ui.select({ ...studio, serverVersion: "0.1.6" }, { trustedClient: false }),
      ).toBe(false);
      expect(yield* ui.serverAuthorization(studioOrigin)).toBeNull();
      expect(yield* ui.sourceOrigin).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps each window's source document while another window selects", () =>
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
          profiles: [studio, cloudbox].map((entry) => ({
            _tag: "BearerConnectionProfile",
            connectionId: entry.environmentId,
            environmentId: entry.environmentId,
            label: entry.environmentId,
            httpBaseUrl: entry.httpBaseUrl,
            wsBaseUrl: entry.httpBaseUrl.replace("https", "wss"),
          })),
          credentials: [studio, cloudbox].map((entry) => ({
            connectionId: entry.environmentId,
            credential: {
              _tag: "BearerConnectionCredential",
              token: `token-${entry.environmentId}`,
            },
          })),
          remoteDpopTokens: [],
          disabledEnvironmentIds: [],
        }),
      );
      const ui = yield* make.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          stateDir,
          appVersion: "0.1.6",
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
        Effect.provideService(LocalAuth.DesktopLocalEnvironmentAuth, {
          getBearerToken: Effect.fail(
            new LocalAuth.DesktopLocalEnvironmentAuthBackendNotConfiguredError(),
          ),
        } as unknown as LocalAuth.DesktopLocalEnvironmentAuth["Service"]),
        Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
          activeEnvironments: Effect.succeed([]),
        } as unknown as DesktopSshEnvironment.DesktopSshEnvironment["Service"]),
      );
      expect(yield* ui.select(studio, { rendererId: 1 })).toBe(true);
      expect(yield* ui.sourceOriginFor(1)).toEqual(new URL(studio.httpBaseUrl + "/"));
      expect(yield* ui.select({ ...cloudbox, httpBaseUrl: null }, { rendererId: 2 })).toBe(true);
      expect(yield* ui.sourceOrigin).toBeNull();
      expect(yield* ui.sourceOriginFor(1)).toEqual(new URL(studio.httpBaseUrl + "/"));
      expect(yield* ui.sourceOriginFor(2)).toBeNull();
      expect(yield* ui.sourceOriginFor(3)).toBeNull();
      expect(yield* ui.select(studio, { rendererId: 1, trustedClient: false })).toBe(false);
      expect(yield* ui.sourceOriginFor(1)).toEqual(new URL(studio.httpBaseUrl + "/"));
      expect(yield* ui.sourceOrigin).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
