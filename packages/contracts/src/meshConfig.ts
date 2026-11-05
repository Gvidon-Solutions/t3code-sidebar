import * as Schema from "effect/Schema";

const open = <const F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]);
export const MachineName = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
const isMachineName = Schema.is(MachineName);
export const LinkPermissions = open({
  files: Schema.optionalKey(Schema.Literals(["all", "projects", "none"])),
  replicas: Schema.optionalKey(Schema.Boolean),
  threads: Schema.optionalKey(Schema.Boolean),
});
const Policy = {
  conflicts: Schema.optionalKey(Schema.Literals(["primary-wins", "newest-wins"])),
  replica: Schema.optionalKey(Schema.Literals(["lite", "full"])),
  ignore: Schema.optionalKey(Schema.Array(Schema.String)),
};
export const MeshConfigDocument = open({
  schema: Schema.Number,
  t3: Schema.optionalKey(open({ version: Schema.optionalKey(Schema.String) })),
  machines: Schema.Record(
    Schema.String,
    open({
      label: Schema.optionalKey(Schema.String),
      title: Schema.optionalKey(Schema.String),
      color: Schema.optionalKey(Schema.String),
      aliases: Schema.optionalKey(Schema.Array(Schema.String)),
      reach: Schema.optionalKey(
        Schema.Union([
          Schema.Literal("auto"),
          open({ address: Schema.String }),
          open({ via: MachineName }),
        ]),
      ),
      ssh: Schema.optionalKey(
        open({
          user: Schema.optionalKey(Schema.String),
          port: Schema.optionalKey(
            Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
          ),
        }),
      ),
      bootstrap: Schema.optionalKey(open({ ssh: Schema.String, os: Schema.String })),
    }),
  ).check(
    Schema.makeFilter((machines) => Object.keys(machines).every((name) => isMachineName(name)), {
      message: "Machine names must be slugs",
    }),
  ),
  links: Schema.optionalKey(
    open({
      default: Schema.optionalKey(LinkPermissions),
      overrides: Schema.optionalKey(
        Schema.Array(
          open({
            between: Schema.Tuple([MachineName, MachineName]),
            ...LinkPermissions.schema.fields,
          }),
        ),
      ),
    }),
  ),
  ssh: Schema.optionalKey(open({ mode: Schema.Literals(["managed", "existing", "off"]) })),
  projects: Schema.optionalKey(
    open({
      defaults: Schema.optionalKey(open(Policy)),
      overrides: Schema.optionalKey(Schema.Array(open({ project: Schema.String, ...Policy }))),
    }),
  ),
  replicas: Schema.optionalKey(
    open({
      ignore: Schema.optionalKey(Schema.Array(Schema.String)),
      rules: Schema.optionalKey(
        Schema.Array(
          open({
            project: Schema.String,
            on: MachineName,
            when: Schema.Literals(["always", "harness-unavailable", "manual"]),
          }),
        ),
      ),
    }),
  ),
  agents: Schema.optionalKey(
    open({
      aliases: Schema.optionalKey(
        Schema.Record(Schema.String, open({ harness: Schema.String, model: Schema.String })),
      ),
      instructions: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type MeshConfigDocument = typeof MeshConfigDocument.Type;
export const MeshConfigRevision = Schema.Struct({
  sequence: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  revision: Schema.String,
  doc: MeshConfigDocument,
  author: Schema.String,
  writtenAt: Schema.String,
});
export type MeshConfigRevision = typeof MeshConfigRevision.Type;
export class MeshConfigError extends Schema.TaggedError<MeshConfigError>()("MeshConfigError", {
  reason: Schema.Literals(["validation", "stale_revision", "not_found", "storage"]),
  message: Schema.String,
  current: Schema.optionalKey(MeshConfigRevision),
  diff: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        before: Schema.optionalKey(Schema.Unknown),
        after: Schema.optionalKey(Schema.Unknown),
      }),
    ),
  ),
}) {}

export const MeshConfigAction = Schema.Struct({
  id: Schema.String,
  server: Schema.String,
  description: Schema.String,
  project: Schema.optionalKey(Schema.String),
  machine: Schema.optionalKey(Schema.String),
});
export type MeshConfigAction = typeof MeshConfigAction.Type;
export const MeshConfigActionStatus = Schema.Struct({
  ...MeshConfigAction.fields,
  state: Schema.Literals(["done", "in_progress", "failed"]),
  reason: Schema.optionalKey(Schema.String),
});
export const MeshConfigServerStatus = Schema.Struct({
  environmentId: Schema.String,
  revision: Schema.NullOr(Schema.String),
  actions: Schema.Array(MeshConfigActionStatus),
});
export const MeshConfigStatus = Schema.Struct({ servers: Schema.Array(MeshConfigServerStatus) });
export type MeshConfigStatus = typeof MeshConfigStatus.Type;
export const MeshConfigSnapshot = Schema.Struct({
  current: Schema.NullOr(MeshConfigRevision),
  bindings: Schema.Record(Schema.String, Schema.String),
});
export const MeshConfigPlan = Schema.Struct({
  doc: MeshConfigDocument,
  actions: Schema.Array(MeshConfigAction),
});
export const MeshConfigPlanInput = Schema.Struct({ doc: Schema.Unknown });
export const MeshConfigApplyInput = Schema.Struct({
  doc: Schema.Unknown,
  baseRevision: Schema.NullOr(Schema.String),
});
export const MeshConfigRollbackInput = Schema.Struct({ revision: Schema.String });
export const MeshConfigHistory = Schema.Struct({ revisions: Schema.Array(MeshConfigRevision) });
