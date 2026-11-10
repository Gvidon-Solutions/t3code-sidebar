import * as Schema from "effect/Schema";

export class RunRemoteError extends Schema.TaggedError<RunRemoteError>()("RunRemoteError", {
  detail: Schema.String,
  reason: Schema.optionalKey(Schema.Literals(["job_not_found"])),
}) {
  override get message() {
    return this.detail;
  }
}
