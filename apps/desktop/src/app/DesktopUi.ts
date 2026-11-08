import type { DesktopUiInfo, DesktopUiSelection } from "@t3tools/contracts";
import { DesktopUiSelection as SelectionSchema } from "@t3tools/contracts";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { resolveLoopbackSshHttpBaseUrl } from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";

const decodeSelection = Schema.decodeEffect(Schema.fromJsonString(SelectionSchema));
const encodeSelection = Schema.encodeEffect(Schema.fromJsonString(SelectionSchema));
const decodeCatalog = Schema.decodeEffect(Schema.fromJsonString(ConnectionCatalogDocument));

export class DesktopUiError extends Schema.TaggedError<DesktopUiError>()("DesktopUiError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

function desktopUiOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      "UI source requires HTTPS or loopback HTTP without credentials, query or fragment",
    );
  return url.href.replace(/\/$/, "");
}

export class DesktopUi extends Context.Service<
  DesktopUi,
  {
    readonly selection: Effect.Effect<DesktopUiSelection | null>;
    readonly connectionOrigins: Effect.Effect<ReadonlyArray<string>, DesktopUiError>;
    readonly select: (selection: DesktopUiSelection) => Effect.Effect<boolean, DesktopUiError>;
    readonly getInfo: Effect.Effect<DesktopUiInfo>;
    readonly recordSource: (origin: URL | null, reason?: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopUi") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const catalog = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const exposure = yield* DesktopServerExposure.DesktopServerExposure;
  const selected = yield* Ref.make<DesktopUiSelection | null>(null);
  const loaded = yield* Ref.make<{
    origin: string | null;
    reason: string | null;
    version: string;
    environmentId: DesktopUiInfo["environmentId"];
  }>({
    origin: null,
    reason: null,
    version: environment.appVersion,
    environmentId: null,
  });
  const mutex = yield* Semaphore.make(1);
  const selectionPath = path.join(environment.stateDir, "ui-source.json");
  const authorize = Effect.fn("desktop.ui.authorize")(function* (input: DesktopUiSelection) {
    const origin =
      input.httpBaseUrl === null
        ? null
        : yield* Effect.try(() => desktopUiOrigin(input.httpBaseUrl!));
    const local = yield* exposure.backendConfig;
    if (local.port > 0 && desktopUiOrigin(local.httpBaseUrl.href) === origin) return true;
    const raw = yield* catalog.get;
    if (Option.isNone(raw))
      return yield* new DesktopUiError({
        message: "No saved connection authorizes this UI source",
      });
    const doc = yield* decodeCatalog(raw.value);
    if (!doc.targets.some((entry) => entry.environmentId === input.environmentId))
      return yield* new DesktopUiError({ message: "This environment is not a saved connection" });
    if (doc.disabledEnvironmentIds.includes(input.environmentId))
      return yield* new DesktopUiError({ message: "This connection is disabled" });
    const profile = yield* Effect.try(() =>
      doc.profiles.find(
        (entry) =>
          entry.environmentId === input.environmentId &&
          entry._tag === "BearerConnectionProfile" &&
          desktopUiOrigin(entry.httpBaseUrl) === origin,
      ),
    );
    if (profile) return true;
    if (
      doc.profiles.some(
        (entry) =>
          entry.environmentId === input.environmentId &&
          entry._tag === "SshConnectionProfile" &&
          origin !== null,
      )
    ) {
      yield* resolveLoopbackSshHttpBaseUrl(origin!);
      return true;
    }
    if (
      doc.targets.some(
        (entry) =>
          entry.environmentId === input.environmentId && entry._tag === "RelayConnectionTarget",
      )
    )
      return false;
    return yield* new DesktopUiError({
      message: "This connection has no authorized direct UI route",
    });
  });
  // Safe storage becomes available after Electron is ready.
  const restore = yield* Effect.cached(
    Effect.gen(function* () {
      if (yield* fs.exists(selectionPath)) {
        yield* fs.readFileString(selectionPath).pipe(
          Effect.flatMap(decodeSelection),
          Effect.flatMap((value) =>
            authorize(value).pipe(
              Effect.map((direct) => ({
                ...value,
                httpBaseUrl: direct ? desktopUiOrigin(value.httpBaseUrl!) : null,
              })),
            ),
          ),
          Effect.flatMap((value) => Ref.set(selected, value)),
          Effect.catch((error) =>
            Effect.logWarning("Saved desktop UI source could not be restored", error),
          ),
        );
      }
    }).pipe(
      Effect.catch((error) => Effect.logWarning("Saved desktop UI source restore failed", error)),
    ),
  );
  const select = Effect.fn("desktop.ui.select")(
    function* (input: DesktopUiSelection) {
      yield* restore;
      const direct = yield* authorize(input);
      const normalized = {
        ...input,
        httpBaseUrl: direct ? desktopUiOrigin(input.httpBaseUrl!) : null,
      };
      const current = yield* Ref.get(selected);
      if (
        current?.environmentId === normalized.environmentId &&
        current.httpBaseUrl === normalized.httpBaseUrl &&
        current.serverVersion === normalized.serverVersion
      )
        return false;
      const encoded = yield* encodeSelection(normalized);
      yield* fs.makeDirectory(environment.stateDir, { recursive: true });
      yield* fs.writeFileString(selectionPath + ".tmp", encoded);
      yield* fs.rename(selectionPath + ".tmp", selectionPath);
      yield* Ref.set(selected, normalized);
      return !environment.isDevelopment;
    },
    mutex.withPermits(1),
    Effect.mapError(
      (cause) =>
        new DesktopUiError({
          message: `Desktop UI source selection failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    ),
  );
  return DesktopUi.of({
    connectionOrigins: Effect.gen(function* () {
      const local = yield* exposure.backendConfig;
      const selectedSource = yield* Ref.get(selected);
      const raw = yield* catalog.get;
      const doc = Option.isSome(raw) ? yield* decodeCatalog(raw.value) : null;
      return [
        ...new Set([
          ...(local.port > 0 ? [local.httpBaseUrl.origin] : []),
          ...(selectedSource?.httpBaseUrl ? [new URL(selectedSource.httpBaseUrl).origin] : []),
          ...(doc?.profiles.flatMap((entry) =>
            entry._tag === "BearerConnectionProfile" &&
            !doc.disabledEnvironmentIds.includes(entry.environmentId)
              ? [new URL(desktopUiOrigin(entry.httpBaseUrl)).origin]
              : [],
          ) ?? []),
        ]),
      ];
    }).pipe(
      Effect.mapError(
        (cause) => new DesktopUiError({ message: "Cannot resolve authorized UI origins", cause }),
      ),
    ),
    selection: restore.pipe(Effect.andThen(Ref.get(selected))),
    select,
    recordSource: Effect.fn("desktop.ui.recordSource")(function* (origin, reason) {
      const current = yield* Ref.get(selected);
      yield* Ref.set(loaded, {
        origin: origin?.href ?? null,
        reason:
          reason ??
          (current?.httpBaseUrl === null
            ? "This connection has no direct UI route; using bundled client"
            : null),
        version:
          origin === null
            ? environment.appVersion
            : (current?.serverVersion ?? environment.appVersion),
        environmentId: current?.environmentId ?? null,
      });
    }),
    getInfo: Effect.gen(function* () {
      yield* restore;
      const source = yield* Ref.get(loaded);
      const selection = yield* Ref.get(selected);
      return {
        source: environment.isDevelopment
          ? "development"
          : source.origin === null
            ? "bundled"
            : "server",
        origin: source.origin,
        environmentId: source.environmentId ?? selection?.environmentId ?? null,
        version: source.version,
        shellVersion: environment.appVersion,
        reason: source.reason,
      };
    }),
  });
});
export const layer = Layer.effect(DesktopUi, make);
