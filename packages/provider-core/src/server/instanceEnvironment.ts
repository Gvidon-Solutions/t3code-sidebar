import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as NodePath from "node:path";

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
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment ?? []) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  if (runtime) {
    Object.assign(next, runtime.environment);
    next.PATH = [
      runtime.directory,
      ...(next.PATH ?? "")
        .split(NodePath.delimiter)
        .filter((directory) => directory !== runtime.directory),
    ].join(NodePath.delimiter);
  }
  return runtime?.mapEnvironment ? runtime.mapEnvironment(next) : next;
});
