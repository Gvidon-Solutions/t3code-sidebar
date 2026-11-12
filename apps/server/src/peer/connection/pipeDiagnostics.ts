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

/**
 * Records the first data chunk's byte count only; a prepended data tap starts
 * flow on the next tick and keeps every byte for the synchronous bridge.
 */
export const observeFirstReadable = (
  stream: NodeStream.Readable,
  report: (stage: string, fields: Readonly<Record<string, number>>) => void,
) => {
  if (!pipeDiagnosticsEnabled()) return;
  stream.prependOnceListener("data", (chunk: Buffer | string) =>
    report("data", {
      bufferedBytes: typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length,
    }),
  );
};
