// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Fixture-only pipe stage tracing reads an explicit test flag, stamps stages directly, and never logs payload bytes.
import type * as NodeStream from "node:stream";
import * as Effect from "effect/Effect";

const pipeDiagnosticsEnabled = () => process.env.T3_MESH_TEST_MODE === "1";

export const tracePipe = (
  stage: string,
  fields: Readonly<Record<string, string | number | boolean>> = {},
): Effect.Effect<void> =>
  pipeDiagnosticsEnabled()
    ? Effect.logInfo(`Mesh pipe ${stage}`, { ...fields, at: Date.now() })
    : Effect.void;

/** Reports the first buffered bytes without reading or otherwise consuming them. */
export const observeFirstReadable = (
  stream: NodeStream.Readable,
  report: (stage: string, fields: Readonly<Record<string, number>>) => void,
) => {
  if (!pipeDiagnosticsEnabled()) return;
  stream.once("readable", () => report("readable", { bufferedBytes: stream.readableLength }));
};
