import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { PeerSessions } from "./PeerSessions.ts";

/** Breaks the initialization cycle: callers share this slot before the network starts. */
export class PeerTransport extends Context.Service<
  PeerTransport,
  {
    readonly get: () => PeerSessions["Service"] | undefined;
    readonly set: (value: PeerSessions["Service"] | undefined) => void;
  }
>()("t3/peer/connection/PeerTransport") {}

export const layer = Layer.sync(PeerTransport, () => {
  let current: PeerSessions["Service"] | undefined;
  return {
    get: () => current,
    set: (value) => {
      current = value;
    },
  };
});
