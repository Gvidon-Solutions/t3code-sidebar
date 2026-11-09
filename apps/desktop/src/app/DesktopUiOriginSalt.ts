// @effect-diagnostics-next-line nodeBuiltinImport:off -- A persistent random install salt is a filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SALT_FILE = "server-ui-origin-salt";

/**
 * A per-install salt keeps each window's server-UI origin stable across restarts, so drafts
 * and browser storage survive, while remaining unguessable from any page.
 */
export const loadServerUiOriginSalt = Effect.fn("loadServerUiOriginSalt")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(stateDir, SALT_FILE);
  const existing = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  const trimmed = existing.trim();
  if (/^[a-f0-9]{32,}$/i.test(trimmed)) return trimmed;
  const salt = NodeCrypto.randomBytes(24).toString("hex");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* fs.writeFileString(file, salt, { mode: 0o600 });
  return salt;
});
