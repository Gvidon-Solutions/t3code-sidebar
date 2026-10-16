/**
 * Fork: requests from agents to show something on the owner's clients. The
 * server only relays them; each client applies a request when it holds that
 * thread's voice conversation or is showing the thread (client-runtime
 * uiRequests). Nothing is stored or replayed.
 */
import type { ThreadId, UiOpenTarget, UiRequest } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface UiRequestsShape {
  /** Sends a request to every connected client; returns how many were connected. */
  readonly open: (input: {
    readonly threadId: ThreadId;
    readonly target: UiOpenTarget;
  }) => Effect.Effect<number>;
  /** One client's subscription, counted from the moment it is taken. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<UiRequest>, never, Scope.Scope>;
  readonly stream: Stream.Stream<UiRequest>;
}

export class UiRequests extends Context.Service<UiRequests, UiRequestsShape>()(
  "t3/uiRequests/UiRequests",
) {}

export const layer = Layer.effect(
  UiRequests,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<UiRequest>();
    const subscribers = yield* Ref.make(0);
    const sequence = yield* Ref.make(0);

    const open: UiRequestsShape["open"] = ({ threadId, target }) =>
      Effect.gen(function* () {
        // Unique across restarts: clients remember the last id they handled.
        const id = `ui-request:${yield* Clock.currentTimeMillis}:${yield* Ref.updateAndGet(sequence, (value) => value + 1)}`;
        yield* PubSub.publish(pubsub, { id, threadId, target });
        return yield* Ref.get(subscribers);
      });

    const subscribe = Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(pubsub);
      yield* Effect.acquireRelease(
        Ref.update(subscribers, (value) => value + 1),
        () => Ref.update(subscribers, (value) => value - 1),
      );
      return subscription;
    });
    const stream = Stream.unwrap(Effect.map(subscribe, Stream.fromSubscription));

    return { open, subscribe, stream } satisfies UiRequestsShape;
  }),
);
