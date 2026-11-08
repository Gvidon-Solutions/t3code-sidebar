import { readLine } from "../platform/readLine.ts";
// @effect-diagnostics nodeBuiltinImport:off -- A primary runtime loads its native PTY addon through its own module resolver.
import * as NodeModule from "node:module";
import { nativeInvocation, workerPlatform } from "../platform/ServerPlatform.ts";
import { workerPolicy } from "./RunWorkerPolicy.ts";
import { runWorkerMain } from "./RunWorker.ts";
const requireNative = NodeModule.createRequire(import.meta.url);
export function runWorker(payload: string) {
  return runWorkerMain(
    requireNative,
    payload,
    nativeInvocation,
    workerPlatform,
    workerPolicy,
    readLine,
  );
}
