/**
 * Fork: agents' requests to show something on the owner's clients, and spoken voice commands. The
 * server only relays them; a client applies one when it holds the thread's voice conversation or
 * shows the thread (client-runtime uiRequests). Nothing is stored or replayed.
 */
import type {
  ThreadId,
  UiOpenTarget,
  UiRequest,
  VoiceCommand,
  VoiceCommandAction,
} from "@t3tools/contracts";
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
  /** Sends a voice command to every connected client; returns how many were connected. */
  readonly voice: (input: {
    readonly threadId: ThreadId;
    readonly action: VoiceCommandAction;
  }) => Effect.Effect<number>;
  readonly voiceStream: Stream.Stream<VoiceCommand>;
}

export class UiRequests extends Context.Service<UiRequests, UiRequestsShape>()(
  "t3/uiRequests/UiRequests",
) {}

export const layer = Layer.effect(
  UiRequests,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<UiRequest>();
    const voicePubsub = yield* PubSub.unbounded<VoiceCommand>();
    const subscribers = yield* Ref.make(0);
    const voiceSubscribers = yield* Ref.make(0);
    const sequence = yield* Ref.make(0);

    // Unique across restarts: clients remember the last id they handled.
    const nextId = Effect.fn("UiRequests.nextId")(function* (prefix: string) {
      const at = yield* Clock.currentTimeMillis;
      return `${prefix}:${at}:${yield* Ref.updateAndGet(sequence, (value) => value + 1)}`;
    });

    const open: UiRequestsShape["open"] = Effect.fn("UiRequests.open")(function* ({
      threadId,
      target,
    }) {
      yield* PubSub.publish(pubsub, { id: yield* nextId("ui-request"), threadId, target });
      return yield* Ref.get(subscribers);
    });

    const voice: UiRequestsShape["voice"] = Effect.fn("UiRequests.voice")(function* ({
      threadId,
      action,
    }) {
      yield* PubSub.publish(voicePubsub, {
        id: yield* nextId("voice-command"),
        threadId,
        action,
      });
      return yield* Ref.get(voiceSubscribers);
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
    const voiceStream = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(voicePubsub);
        yield* Effect.acquireRelease(
          Ref.update(voiceSubscribers, (value) => value + 1),
          () => Ref.update(voiceSubscribers, (value) => value - 1),
        );
        return Stream.fromSubscription(subscription);
      }),
    );

    return { open, subscribe, stream, voice, voiceStream } satisfies UiRequestsShape;
  }),
);
