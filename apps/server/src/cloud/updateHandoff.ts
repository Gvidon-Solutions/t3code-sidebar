import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off - joins the runtime directory without adding an Effect requirement to the daemon finalizer.
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import {
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";

const DESKTOP_UPDATE_RESTART_MARKER_TTL = Duration.minutes(1);

export const pendingServiceUpdateExists = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDir = path.join(config.baseDir, "runtime");
  const stateText = yield* fs
    .readFileString(path.join(runtimeDir, SERVICE_STATE_FILE))
    .pipe(Effect.option);
  return Option.isSome(stateText) && serviceStateHasPendingUpdate(stateText.value);
});

/** Keeps callers that only know the T3 home (the Mutagen data directory's parent) independent of ServerConfig. */
export const pendingUpdateHandoffAt = Effect.fn("pendingUpdateHandoffAt")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const runtimeDir = NodePath.join(baseDir, "runtime");
  const stateText = yield* fs
    .readFileString(NodePath.join(runtimeDir, SERVICE_STATE_FILE))
    .pipe(Effect.option);
  if (!(Option.isSome(stateText) && serviceStateHasPendingUpdate(stateText.value))) {
    return false;
  }
  const stopping = yield* fs
    .exists(NodePath.join(runtimeDir, SERVICE_STOP_MARKER_FILE))
    .pipe(Effect.orElseSucceed(() => false));
  return !stopping;
});

export const pendingUpdateHandoffExists = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return yield* pendingUpdateHandoffAt(config.baseDir);
});

// Reading consumes it, so shutdown checks it first.
export const desktopUpdateRestartPending = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = path.join(config.baseDir, "runtime", DESKTOP_UPDATE_RESTART_MARKER_FILE);
  const marker = yield* fs.stat(markerPath).pipe(Effect.option);
  if (Option.isNone(marker)) {
    return false;
  }
  yield* fs.remove(markerPath).pipe(Effect.ignore);
  const now = yield* Clock.currentTimeMillis;
  return Option.match(marker.value.mtime, {
    onNone: () => false,
    onSome: (writtenAt) =>
      now - writtenAt.getTime() < Duration.toMillis(DESKTOP_UPDATE_RESTART_MARKER_TTL),
  });
});
