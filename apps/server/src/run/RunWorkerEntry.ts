// @effect-diagnostics nodeBuiltinImport:off -- A primary runtime loads its own native PTY addon and evaluates the same supervised worker as the SSH Node launcher.
import * as NodeModule from "node:module";
import { nativeInvocation } from "./RunPlatform.ts";
import { RUN_WORKER_SOURCE } from "./RunWorker.ts";
const requireNative = NodeModule.createRequire(import.meta.url);
export function runWorker(payload: string) {
  const execute = new Function(
    "require",
    "__T3_RUN_PAYLOAD",
    "__T3_RUN_RESOLVE",
    RUN_WORKER_SOURCE,
  );
  execute(requireNative, payload, nativeInvocation);
}
