import type { DesktopUiInfo, DesktopUiSelection } from "@t3tools/contracts";
import {
  DesktopUiSelection as SelectionSchema,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { isStrictlyNewerSemver } from "@t3tools/shared/semver";
import { resolveLoopbackSshHttpBaseUrl } from "@t3tools/ssh/tunnel";
import * as Clock from "effect/Clock";
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
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";

const decodeSelection = Schema.decodeEffect(Schema.fromJsonString(SelectionSchema));
const encodeSelection = Schema.encodeEffect(Schema.fromJsonString(SelectionSchema));
const decodeCatalog = Schema.decodeEffect(Schema.fromJsonString(ConnectionCatalogDocument));

/** A rejected source is retried after this; a transient proxy/auth outage must not lock it out. */
const SERVER_UI_REJECTION_TTL_MS = 2 * 60_000;
const SERVER_UI_REJECTION_FAILURES = 2;

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

function sameSshTarget(
  left: {
    readonly alias: string;
    readonly hostname: string;
    readonly username?: string | null;
    readonly port?: number | null;
  },
  right: {
    readonly alias: string;
    readonly hostname: string;
    readonly username?: string | null;
    readonly port?: number | null;
  },
): boolean {
  return (
    left.alias === right.alias &&
    left.hostname === right.hostname &&
    (left.username ?? null) === (right.username ?? null) &&
    (left.port ?? null) === (right.port ?? null)
  );
}

function isLoopbackOrigin(origin: string): boolean {
  const url = new URL(origin);
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export interface ServerUiAuthorization {
  readonly authorization: string;
  readonly environmentId: EnvironmentId;
}

interface RejectionRecord {
  readonly token: string;
  readonly failures: number;
  readonly rejectedAt: number | null;
}

const rejectionKey = (environmentId: EnvironmentId, origin: string) =>
  `${environmentId}\u0000${origin}`;

export class DesktopUi extends Context.Service<
  DesktopUi,
  {
    readonly selection: Effect.Effect<DesktopUiSelection | null>;
    readonly selectionLabel: Effect.Effect<string | null>;
    /** The last resolved selection label; never suspends, for synchronous IPC. */
    readonly cachedSelectionLabel: Effect.Effect<string | null>;
    readonly connectionOrigins: Effect.Effect<ReadonlyArray<string>, DesktopUiError>;
    readonly sourceOrigin: Effect.Effect<URL | null>;
    readonly sourceOriginFor: (rendererId: number | null) => Effect.Effect<URL | null>;
    readonly select: (
      selection: DesktopUiSelection,
      options?: { readonly trustedClient?: boolean; readonly rendererId?: number },
    ) => Effect.Effect<boolean, DesktopUiError>;
    readonly serverAuthorization: (origin: URL) => Effect.Effect<ServerUiAuthorization | null>;
    readonly noteAuthorizationRejected: (origin: URL, authorization: string) => Effect.Effect<void>;
    readonly retryServerUi: Effect.Effect<void>;
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
  const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const ssh = yield* DesktopSshEnvironment.DesktopSshEnvironment;
  const selected = yield* Ref.make<DesktopUiSelection | null>(null);
  const rejections = yield* Ref.make<ReadonlyMap<string, RejectionRecord>>(new Map());
  // Server UI credentials are per source origin, so another window selecting its own
  // environment cannot withhold this window's credential.
  const authorizedOrigins = yield* Ref.make<
    ReadonlyMap<string, { readonly environmentId: EnvironmentId; readonly serverVersion: string }>
  >(new Map());
  const rendererSelections = yield* Ref.make<ReadonlyMap<number, DesktopUiSelection>>(new Map());
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
  const serverUiIsNewer = (serverVersion: string) =>
    isStrictlyNewerSemver(serverVersion, environment.appVersion);
  const rememberOrigin = (origin: string, environmentId: EnvironmentId, serverVersion: string) =>
    Ref.update(authorizedOrigins, (current) => {
      const next = new Map(current);
      next.set(origin, { environmentId, serverVersion });
      return next;
    });
  const forgetOrigin = (origin: string) =>
    Ref.update(authorizedOrigins, (current) => {
      if (!current.has(origin)) return current;
      const next = new Map(current);
      next.delete(origin);
      return next;
    });
  const selectionFor = Effect.fn("desktop.ui.selectionFor")(function* (rendererId: number | null) {
    if (rendererId !== null) {
      const perRenderer = (yield* Ref.get(rendererSelections)).get(rendererId);
      if (perRenderer !== undefined) return perRenderer;
    }
    return yield* Ref.get(selected);
  });
  // A source only exists for an environment this shell can serve: the local backend
  // while it is on, or a saved connection that is not toggled off.
  const environmentCanServeUi = Effect.fn("desktop.ui.environmentCanServeUi")(function* (
    environmentId: EnvironmentId,
  ) {
    const local = yield* exposure.backendConfig;
    if (environmentId === EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID)) return local.port > 0;
    const raw = yield* catalog.get.pipe(Effect.orElseSucceed(() => Option.none<string>()));
    if (Option.isNone(raw)) return false;
    const doc = yield* decodeCatalog(raw.value).pipe(Effect.orElseSucceed(() => null));
    if (doc === null) return false;
    return (
      doc.targets.some((entry) => entry.environmentId === environmentId) &&
      !doc.disabledEnvironmentIds.includes(environmentId)
    );
  });
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
  const environmentForOrigin = Effect.fn("desktop.ui.environmentForOrigin")(function* (
    origin: string,
  ): Effect.fn.Return<EnvironmentId | null> {
    const local = yield* exposure.backendConfig;
    if (local.port > 0 && desktopUiOrigin(local.httpBaseUrl.href) === origin) {
      return EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID);
    }
    const current = yield* Ref.get(selected);
    if (current?.httpBaseUrl !== null && current?.httpBaseUrl !== undefined) {
      if (desktopUiOrigin(current.httpBaseUrl) === origin) return current.environmentId;
    }
    const raw = yield* catalog.get.pipe(Effect.orElseSucceed(() => Option.none<string>()));
    if (Option.isNone(raw)) return null;
    const doc = yield* decodeCatalog(raw.value).pipe(Effect.orElseSucceed(() => null));
    if (doc === null) return null;
    const candidates = new Set<EnvironmentId>();
    for (const profile of doc.profiles) {
      if (
        profile._tag === "BearerConnectionProfile" &&
        desktopUiOrigin(profile.httpBaseUrl) === origin
      ) {
        candidates.add(profile.environmentId);
      }
    }
    return candidates.size === 1 ? [...candidates][0]! : null;
  });
  const credentialFor = Effect.fn("desktop.ui.credentialFor")(function* (
    environmentId: EnvironmentId,
    origin: string,
  ): Effect.fn.Return<string | null> {
    const local = yield* exposure.backendConfig;
    if (
      environmentId === PRIMARY_LOCAL_ENVIRONMENT_ID &&
      local.port > 0 &&
      desktopUiOrigin(local.httpBaseUrl.href) === origin
    ) {
      return yield* localAuth.getBearerToken.pipe(
        Effect.timeoutOption("5 seconds"),
        Effect.map(Option.getOrElse(() => null)),
        Effect.orElseSucceed(() => null),
      );
    }
    const raw = yield* catalog.get.pipe(Effect.orElseSucceed(() => Option.none<string>()));
    if (Option.isNone(raw)) return null;
    const doc = yield* decodeCatalog(raw.value).pipe(Effect.orElseSucceed(() => null));
    if (doc === null) return null;
    if (!doc.targets.some((entry) => entry.environmentId === environmentId)) return null;
    if (doc.disabledEnvironmentIds.includes(environmentId)) return null;
    const authorized = yield* authorize({
      environmentId,
      httpBaseUrl: origin,
      serverVersion: "",
    }).pipe(Effect.orElseSucceed(() => false));
    if (!authorized) return null;
    const bearer = doc.profiles.find(
      (entry) =>
        entry.environmentId === environmentId &&
        entry._tag === "BearerConnectionProfile" &&
        desktopUiOrigin(entry.httpBaseUrl) === origin,
    );
    if (bearer) {
      return (
        doc.credentials.find((entry) => entry.connectionId === bearer.connectionId)?.credential
          .token ?? null
      );
    }
    const sshProfile = doc.profiles.find(
      (entry) => entry.environmentId === environmentId && entry._tag === "SshConnectionProfile",
    );
    if (sshProfile?._tag === "SshConnectionProfile" && isLoopbackOrigin(origin)) {
      const active = yield* ssh.activeEnvironments.pipe(Effect.orElseSucceed(() => []));
      const tunnel = active.find((entry) => desktopUiOrigin(entry.httpBaseUrl) === origin);
      if (tunnel === undefined || !sameSshTarget(tunnel.target, sshProfile.target)) return null;
      return (
        doc.credentials.find((entry) => entry.connectionId === sshProfile.connectionId)?.credential
          .token ?? null
      );
    }
    return null;
  });
  const rejectionIsActive = Effect.fn("desktop.ui.rejectionIsActive")(function* (
    environmentId: EnvironmentId,
    origin: string,
    token: string,
  ): Effect.fn.Return<boolean> {
    const record = (yield* Ref.get(rejections)).get(rejectionKey(environmentId, origin));
    if (record === undefined || record.token !== token) return false;
    if (record.failures < SERVER_UI_REJECTION_FAILURES || record.rejectedAt === null) return false;
    const now = yield* Clock.currentTimeMillis;
    if (now - record.rejectedAt >= SERVER_UI_REJECTION_TTL_MS) {
      yield* Ref.update(rejections, (current) => {
        const next = new Map(current);
        next.delete(rejectionKey(environmentId, origin));
        return next;
      });
      return false;
    }
    return true;
  });
  // Safe storage becomes available after Electron is ready.
  const labelCache = yield* Ref.make<string | null>(null);
  const resolveLabelUncached = Effect.gen(function* () {
    const current = yield* Ref.get(selected);
    if (current === null) return null;
    const raw = yield* catalog.get;
    if (Option.isNone(raw)) return null;
    const doc = yield* decodeCatalog(raw.value);
    const label = doc.targets.find(
      (target) => target.environmentId === current.environmentId,
    )?.label;
    return label === undefined || label.trim() === "" ? null : label.trim();
  }).pipe(Effect.orElseSucceed(() => null));
  const refreshLabel = resolveLabelUncached.pipe(
    Effect.flatMap((label) => Ref.set(labelCache, label)),
  );
  const restore = yield* Effect.cached(
    Effect.gen(function* () {
      if (yield* fs.exists(selectionPath)) {
        yield* fs.readFileString(selectionPath).pipe(
          Effect.flatMap(decodeSelection),
          Effect.flatMap((value) =>
            Effect.gen(function* () {
              const direct =
                (yield* environmentCanServeUi(value.environmentId)) &&
                value.httpBaseUrl !== null &&
                serverUiIsNewer(value.serverVersion)
                  ? yield* authorize(value)
                  : false;
              const origin = direct ? desktopUiOrigin(value.httpBaseUrl!) : null;
              const token =
                origin === null ? null : yield* credentialFor(value.environmentId, origin);
              const rejected =
                origin !== null && token !== null
                  ? yield* rejectionIsActive(value.environmentId, origin, token)
                  : false;
              const httpBaseUrl = direct && token !== null && !rejected ? origin : null;
              if (httpBaseUrl !== null)
                yield* rememberOrigin(httpBaseUrl, value.environmentId, value.serverVersion);
              return { ...value, httpBaseUrl };
            }),
          ),
          Effect.flatMap((value) => Ref.set(selected, value)),
          Effect.andThen(refreshLabel),
          Effect.catch((error) =>
            Effect.logWarning("Saved desktop UI source could not be restored", error),
          ),
        );
      }
    }).pipe(
      Effect.catch((error) => Effect.logWarning("Saved desktop UI source restore failed", error)),
    ),
  );
  const resolveSelectionLabel = restore.pipe(
    Effect.andThen(resolveLabelUncached),
    Effect.tap((label) => Ref.set(labelCache, label)),
  );
  const select = Effect.fn("desktop.ui.select")(
    function* (
      input: DesktopUiSelection,
      options?: { readonly trustedClient?: boolean; readonly rendererId?: number },
    ) {
      yield* restore;
      const rendererId = options?.rendererId ?? null;
      const direct =
        (yield* environmentCanServeUi(input.environmentId)) &&
        input.httpBaseUrl !== null &&
        serverUiIsNewer(input.serverVersion)
          ? yield* authorize(input)
          : false;
      const origin = direct ? desktopUiOrigin(input.httpBaseUrl!) : null;
      const current = yield* selectionFor(rendererId);
      const token = origin === null ? null : yield* credentialFor(input.environmentId, origin);
      const rejected =
        origin !== null && token !== null
          ? yield* rejectionIsActive(input.environmentId, origin, token)
          : false;
      const trusted = options?.trustedClient !== false;
      const changesEnvironment = current !== null && current.environmentId !== input.environmentId;
      // A reduced server UI may refresh only the source of its own window. Moving the
      // shell's persisted selection would break another window's source and credential.
      if (!trusted && changesEnvironment) {
        if (origin !== null && token !== null && !rejected && serverUiIsNewer(input.serverVersion))
          yield* rememberOrigin(origin, input.environmentId, input.serverVersion);
        else if (input.httpBaseUrl !== null) {
          const invalidOrigin = yield* Effect.try(() => desktopUiOrigin(input.httpBaseUrl!)).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (invalidOrigin !== null) yield* forgetOrigin(invalidOrigin);
        }
        return false;
      }
      const normalized = {
        ...input,
        httpBaseUrl: direct && token !== null && !rejected ? origin : null,
        // An untrusted source may refresh the same source but not churn its version.
        ...(!trusted && current !== null && !changesEnvironment
          ? { serverVersion: current.serverVersion }
          : {}),
      };
      if (
        current?.environmentId === normalized.environmentId &&
        current.httpBaseUrl === normalized.httpBaseUrl &&
        current.serverVersion === normalized.serverVersion
      ) {
        if (normalized.httpBaseUrl !== null)
          yield* rememberOrigin(
            normalized.httpBaseUrl,
            normalized.environmentId,
            normalized.serverVersion,
          );
        if (rendererId !== null)
          yield* Ref.update(rendererSelections, (values) => {
            const next = new Map(values);
            next.set(rendererId, normalized);
            return next;
          });
        return false;
      }
      // The coordinator reloads only when the loaded document changes. A bundled-only
      // environment switch and the first bundled selection change no document.
      const sourceChanged =
        current === null
          ? normalized.httpBaseUrl !== null
          : current.httpBaseUrl !== normalized.httpBaseUrl;
      const versionChanged =
        normalized.httpBaseUrl !== null &&
        current?.httpBaseUrl === normalized.httpBaseUrl &&
        current.serverVersion !== normalized.serverVersion;
      if (!trusted) {
        const changed =
          current?.httpBaseUrl !== normalized.httpBaseUrl ||
          (normalized.httpBaseUrl !== null && current?.serverVersion !== normalized.serverVersion);
        if (rendererId !== null)
          yield* Ref.update(rendererSelections, (values) => {
            const next = new Map(values);
            next.set(rendererId, normalized);
            return next;
          });
        if (normalized.httpBaseUrl !== null)
          yield* rememberOrigin(
            normalized.httpBaseUrl,
            normalized.environmentId,
            normalized.serverVersion,
          );
        return changed;
      }
      const encoded = yield* encodeSelection(normalized);
      yield* fs.makeDirectory(environment.stateDir, { recursive: true });
      yield* fs.writeFileString(selectionPath + ".tmp", encoded);
      yield* fs.rename(selectionPath + ".tmp", selectionPath);
      yield* Ref.set(selected, normalized);
      if (rendererId !== null)
        yield* Ref.update(rendererSelections, (values) => {
          const next = new Map(values);
          next.set(rendererId, normalized);
          return next;
        });
      if (normalized.httpBaseUrl !== null) {
        yield* rememberOrigin(
          normalized.httpBaseUrl,
          normalized.environmentId,
          normalized.serverVersion,
        );
      } else if (
        !rejected &&
        current !== null &&
        current.httpBaseUrl !== null &&
        current.environmentId === normalized.environmentId
      ) {
        // A temporary rejection keeps the origin record: serverAuthorization still
        // withholds the credential until its cooldown ends.
        const previousOrigin = yield* Effect.try(() => desktopUiOrigin(current.httpBaseUrl!)).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (previousOrigin !== null) yield* forgetOrigin(previousOrigin);
      }
      yield* refreshLabel;
      return (sourceChanged || versionChanged) && !environment.isDevelopment;
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
  const resolveSourceOrigin = Effect.fn("desktop.ui.resolveSourceOrigin")(function* (
    current: DesktopUiSelection | null,
  ) {
    if (current !== null) {
      if (current.httpBaseUrl === null) return null;
      if (!serverUiIsNewer(current.serverVersion)) return null;
      if (!(yield* environmentCanServeUi(current.environmentId))) return null;
      const origin = desktopUiOrigin(current.httpBaseUrl);
      const token = yield* credentialFor(current.environmentId, origin);
      if (token === null) return null;
      if (yield* rejectionIsActive(current.environmentId, origin, token)) return null;
      return new URL(current.httpBaseUrl);
    }
    // With no saved source the bundled client starts first; it selects the server UI
    // only when that server's UI is newer than this shell's bundled client.
    return null;
  });
  return DesktopUi.of({
    connectionOrigins: Effect.gen(function* () {
      const local = yield* exposure.backendConfig;
      const selectedSource = yield* Ref.get(selected);
      const selectedUsable =
        selectedSource !== null && (yield* environmentCanServeUi(selectedSource.environmentId));
      const raw = yield* catalog.get;
      const doc = Option.isSome(raw) ? yield* decodeCatalog(raw.value) : null;
      return [
        ...new Set([
          ...(local.port > 0 ? [local.httpBaseUrl.origin] : []),
          ...(selectedUsable && selectedSource?.httpBaseUrl
            ? [new URL(selectedSource.httpBaseUrl).origin]
            : []),
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
    selectionLabel: resolveSelectionLabel,
    cachedSelectionLabel: Ref.get(labelCache),
    sourceOrigin: Effect.gen(function* () {
      yield* restore;
      const current = yield* Ref.get(selected);
      return yield* resolveSourceOrigin(current);
    }),
    sourceOriginFor: Effect.fn("desktop.ui.sourceOriginFor")(function* (rendererId) {
      yield* restore;
      const current = yield* selectionFor(rendererId);
      return yield* resolveSourceOrigin(current);
    }),
    select,
    serverAuthorization: Effect.fn("desktop.ui.serverAuthorization")(function* (origin: URL) {
      yield* restore;
      const source = desktopUiOrigin(origin.href);
      const environmentId = yield* environmentForOrigin(source);
      if (environmentId === null) return null;
      const record = (yield* Ref.get(authorizedOrigins)).get(source);
      if (
        record === undefined ||
        record.environmentId !== environmentId ||
        !serverUiIsNewer(record.serverVersion)
      )
        return null;
      const token = yield* credentialFor(environmentId, source);
      if (token === null) return null;
      if (yield* rejectionIsActive(environmentId, source, token)) return null;
      return { authorization: token, environmentId } satisfies ServerUiAuthorization;
    }),
    noteAuthorizationRejected: Effect.fn("desktop.ui.noteAuthorizationRejected")(function* (
      origin: URL,
      authorization: string,
    ) {
      const source = desktopUiOrigin(origin.href);
      const environmentId = yield* environmentForOrigin(source);
      if (environmentId === null) return;
      const key = rejectionKey(environmentId, source);
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(rejections, (current) => {
        const previous = current.get(key);
        const failures = previous?.token === authorization ? previous.failures + 1 : 1;
        const next = new Map(current);
        next.set(key, {
          token: authorization,
          failures,
          rejectedAt: failures >= SERVER_UI_REJECTION_FAILURES ? now : null,
        });
        return next;
      });
      yield* Ref.set(loaded, {
        origin: null,
        reason: "Server UI authentication failed; using bundled client",
        version: environment.appVersion,
        environmentId: (yield* Ref.get(selected))?.environmentId ?? null,
      });
    }),
    retryServerUi: Ref.set(rejections, new Map()).pipe(
      Effect.andThen(
        Ref.update(loaded, (current) => ({
          ...current,
          reason: null,
        })),
      ),
    ),
    recordSource: Effect.fn("desktop.ui.recordSource")(function* (origin, reason) {
      const current = yield* Ref.get(selected);
      const bundledForVersion =
        current !== null && current.httpBaseUrl === null && !serverUiIsNewer(current.serverVersion);
      yield* Ref.set(loaded, {
        origin: origin?.href ?? null,
        reason:
          reason ??
          (bundledForVersion
            ? "The server UI is not newer than the built-in client; using the built-in client"
            : current?.httpBaseUrl === null
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
