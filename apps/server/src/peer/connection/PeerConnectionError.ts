import * as Schema from "effect/Schema";

export class PeerConnectionError extends Schema.TaggedError<PeerConnectionError>()(
  "PeerConnectionError",
  {
    reason: Schema.Literals(["offline", "relay", "pipe", "protocol"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
