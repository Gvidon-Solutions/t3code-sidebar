import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ServerConfig } from "../config.ts";
import {
  OtaCatalog,
  OtaManifest,
  verifyOtaAsset,
  selectOtaRelease,
  verifyOtaRelease,
} from "./otaProtocol.ts";

const decodeCatalog = Schema.decodeEffect(Schema.fromJsonString(OtaCatalog));
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(OtaManifest));

const headers = {
  "expo-protocol-version": "1",
  "expo-sfv-version": "0",
  "expo-manifest-filters": "",
  "expo-server-defined-headers": "",
  "cache-control": "private, max-age=0",
};
export class MobileOta extends Context.Service<
  MobileOta,
  {
    readonly manifest: (
      request: Readonly<Record<string, string | undefined>>,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
    readonly status: (
      platform: string,
      runtime: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
    readonly asset: (key: string) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("t3/delivery/MobileOta") {}

export const layer = Layer.effect(
  MobileOta,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const root = path.join(config.baseDir, "mobile-updates");
    const catalogLock = yield* Semaphore.make(1);
    let cached:
      | {
          stamp: string;
          catalog: typeof OtaCatalog.Type;
          assets: ReadonlyMap<string, typeof OtaManifest.Type.launchAsset>;
        }
      | undefined;
    const readCatalog = Effect.fn("MobileOta.readCatalog")(() =>
      catalogLock.withPermit(
        Effect.gen(function* () {
          const file = path.join(root, "catalog.json");
          const info = yield* fs.stat(file);
          const stamp = `${info.size}:${Option.getOrUndefined(info.ino)}:${Option.getOrElse(
            Option.map(info.mtime, (time) => time.getTime()),
            () => 0,
          )}`;
          if (cached?.stamp === stamp) return cached;
          const catalog = yield* decodeCatalog(yield* fs.readFileString(file));
          const manifests = yield* Effect.forEach(catalog.releases, (release) =>
            decodeManifest(release.manifest),
          );
          const assets = new Map(
            [
              ...manifests.flatMap((manifest) => [manifest.launchAsset, ...manifest.assets]),
              ...(catalog.apkAsset ? [catalog.apkAsset] : []),
            ].map((asset) => [asset.hash, asset]),
          );
          cached = { stamp, catalog, assets };
          return cached;
        }),
      ),
    );
    const manifest = Effect.fn("MobileOta.manifest")(
      function* (request: Readonly<Record<string, string | undefined>>) {
        if (
          request["expo-protocol-version"] !== "1" ||
          !["android", "ios"].includes(request["expo-platform"] ?? "") ||
          !request["expo-runtime-version"]
        ) {
          return HttpServerResponse.text(
            "Expected Expo protocol 1, platform and native runtime version",
            { status: 400, headers },
          );
        }
        if (!(yield* fs.exists(path.join(root, "catalog.json"))))
          return HttpServerResponse.empty({ status: 204, headers });
        const { catalog } = yield* readCatalog();
        const release = yield* Effect.try(() =>
          selectOtaRelease(
            catalog,
            request["expo-platform"]!,
            request["expo-runtime-version"]!,
            request["t3-update-selection"] === "previous",
            request["t3-rollback-from"] ?? request["expo-current-update-id"],
          ),
        );
        if (!release) return HttpServerResponse.empty({ status: 204, headers });
        const certificate = yield* fs.readFileString(path.join(root, "certificate.pem"));
        const verified = yield* Effect.try(() => verifyOtaRelease(release, certificate));
        return HttpServerResponse.text(release.manifest, {
          headers: {
            ...headers,
            "content-type": "application/expo+json",
            "expo-signature": `sig="${release.signature}", keyid="main", alg="rsa-v1_5-sha256"`,
            "expo-manifest-filters": `bundle="${verified.id}"`,
          },
        });
      },
      Effect.catch((error) =>
        Effect.logError("Mobile OTA manifest refused", error).pipe(
          Effect.as(HttpServerResponse.text("Mobile update unavailable", { status: 503, headers })),
        ),
      ),
    );
    const asset = Effect.fn("MobileOta.asset")(
      function* (key: string) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return HttpServerResponse.empty({ status: 404 });
        const { assets } = yield* readCatalog();
        const known = assets.get(key);
        if (!known) return HttpServerResponse.empty({ status: 404 });
        const bytes = yield* fs.readFile(path.join(root, "assets", key));
        yield* Effect.try(() => verifyOtaAsset(key, bytes));
        return HttpServerResponse.uint8Array(bytes, {
          headers: {
            "content-type": known.contentType,
            ...(known.contentType === "application/vnd.android.package-archive"
              ? { "content-disposition": 'attachment; filename="T3-Code-Sidebar.apk"' }
              : {}),
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'",
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      },
      Effect.catch((error) =>
        Effect.logWarning("Mobile OTA asset unavailable", error).pipe(
          Effect.as(HttpServerResponse.empty({ status: 404 })),
        ),
      ),
    );
    const status = Effect.fn("MobileOta.status")(
      function* (platform: string, runtime: string) {
        if (!(yield* fs.exists(path.join(root, "catalog.json"))))
          return HttpServerResponse.jsonUnsafe({ requiresNativeUpdate: false }, { headers });
        const { catalog } = yield* readCatalog();
        const newest = catalog.releases.filter((release) => release.platform === platform).at(-1);
        const latestRuntime = newest
          ? (yield* decodeManifest(newest.manifest)).runtimeVersion
          : undefined;
        return HttpServerResponse.jsonUnsafe(
          {
            requiresNativeUpdate: latestRuntime !== undefined && latestRuntime !== runtime,
            nativeUpdate: platform === "android" ? catalog.nativeUpdate : undefined,
          },
          { headers },
        );
      },
      Effect.catch((error) =>
        Effect.logError("Mobile OTA status unavailable", error).pipe(
          Effect.as(HttpServerResponse.text("Mobile update unavailable", { status: 503, headers })),
        ),
      ),
    );
    return { manifest, asset, status };
  }),
);

export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const ota = yield* MobileOta;
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/api/mobile-updates/status",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* ota.status(
            request.headers["expo-platform"] ?? "",
            request.headers["expo-runtime-version"] ?? "",
          );
        }),
      ),
      HttpRouter.add(
        "GET",
        "/api/mobile-updates/manifest",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* ota.manifest(request.headers);
        }),
      ),
      HttpRouter.add(
        "GET",
        "/api/mobile-updates/assets/:key",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* ota.asset(request.url.split("?")[0]!.split("/").at(-1)!);
        }),
      ),
    );
  }),
).pipe(Layer.provide(layer));
