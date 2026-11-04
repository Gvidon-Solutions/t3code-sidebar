import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { PeerSessions, PeerEvent } from "./PeerSessions.ts";

export type PeerActivity =
  | { readonly kind: "connected"; readonly environmentId: string }
  | ({ readonly kind: "event" } & PeerEvent);

/** Breaks the initialization cycle: callers share this slot before the network starts. */
export class PeerTransport extends Context.Service<
  PeerTransport,
  {
    readonly get: () => PeerSessions["Service"] | undefined;
    readonly set: (value: PeerSessions["Service"] | undefined) => void;
    readonly activity: Stream.Stream<PeerActivity>;
    readonly publish: (activity: PeerActivity) => Effect.Effect<void>;
  }
>()("t3/peer/connection/PeerTransport") {}

export const layer = Layer.effect(
  PeerTransport,
  Effect.gen(function* () {
    let current: PeerSessions["Service"] | undefined;
    const activity = yield* PubSub.unbounded<PeerActivity>();
    return {
      get: () => current,
      set: (value) => {
        current = value;
      },
      activity: Stream.fromPubSub(activity),
      publish: Effect.fn("PeerTransport.publish")((event) =>
        PubSub.publish(activity, event).pipe(Effect.asVoid),
      ),
    };
  }),
);
