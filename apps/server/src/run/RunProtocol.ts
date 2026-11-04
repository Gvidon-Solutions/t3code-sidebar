import * as Schema from "effect/Schema";
export const RunPlan = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local") }),
  Schema.Struct({
    kind: Schema.Literal("remote"),
    logicalKey: Schema.String,
    environmentId: Schema.String,
    title: Schema.String,
    machine: Schema.String,
    host: Schema.String,
    primaryRoot: Schema.String,
    replicaRoot: Schema.String,
    cwd: Schema.String,
    platform: Schema.String,
    ignores: Schema.Array(Schema.String),
  }),
]);
export type RunPlan = typeof RunPlan.Type;
export type RemoteRunPlan = Extract<RunPlan, { kind: "remote" }>;
export const RunRequest = Schema.Struct({
  action: Schema.Literals(["resolve", "prepare", "finish"]),
  cwd: Schema.String,
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86400000 })),
});
export const RunResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    plan: RunPlan,
    remoteCommands: Schema.Array(Schema.String),
  }),
  Schema.Struct({ ok: Schema.Literal(false), code: Schema.Int, message: Schema.String }),
]);
export const WorkerFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["out", "err"]), data: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("done"),
    code: Schema.Int,
    ignored: Schema.Array(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("ready"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type WorkerFrame = typeof WorkerFrame.Type;
export const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(WorkerFrame));
export const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RunRequest));
export const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(RunResponse));
export const encodeResponse = Schema.encodeSync(Schema.fromJsonString(RunResponse));
export const DEFAULT_REMOTE_COMMANDS = [
  "git",
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "uv",
  "pytest",
  "make",
  "cargo",
  "go",
  "docker",
] as const;
