import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

export const ProviderRuntimeEnvironment = Context.Reference<
  | {
      readonly directory: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly mapEnvironment?: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    }
  | undefined
>("@t3tools/provider-core/server/instanceEnvironment/ProviderRuntimeEnvironment", {
  defaultValue: () => undefined,
});

import { expandHomePath } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  const runtime = yield* ProviderRuntimeEnvironment;
  if ((!environment || environment.length === 0) && !runtime) return baseEnv;

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment ?? []) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] =
      name === "CODEX_HOME" || name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  if (runtime) {
    const delimiter = (yield* HostProcess.Platform) === "win32" ? ";" : ":";
    Object.assign(next, runtime.environment);
    next.PATH = [
      runtime.directory,
      ...(next.PATH ?? "").split(delimiter).filter((directory) => directory !== runtime.directory),
    ].join(delimiter);
  }
  return runtime?.mapEnvironment ? runtime.mapEnvironment(next) : next;
});
