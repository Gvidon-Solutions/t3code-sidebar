import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";

export const DesktopUiSelection = Schema.Struct({
  environmentId: EnvironmentId,
  httpBaseUrl: Schema.NullOr(Schema.String),
  serverVersion: Schema.String,
  /** Shell-only: the bearer the trusted client holds for this environment; never persisted or exposed to server UI. */
  authorization: Schema.optional(Schema.String),
});
export type DesktopUiSelection = typeof DesktopUiSelection.Type;
export const DesktopUiInfo = Schema.Struct({
  source: Schema.Literals(["server", "bundled", "development"]),
  origin: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(EnvironmentId),
  version: Schema.String,
  shellVersion: Schema.String,
  reason: Schema.NullOr(Schema.String),
});
export type DesktopUiInfo = typeof DesktopUiInfo.Type;
