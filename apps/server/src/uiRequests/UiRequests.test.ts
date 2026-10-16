import * as NodeAssert from "node:assert/strict";

import type { ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";

import * as UiRequests from "./UiRequests.ts";

const threadId = "thread-asking" as ThreadId;

it.effect("relays a request to connected clients and counts them", () =>
  Effect.gen(function* () {
    const uiRequests = yield* UiRequests.UiRequests;
    NodeAssert.equal(yield* uiRequests.open({ threadId, target: { kind: "inbox" } }), 0);

    const clients = yield* Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* uiRequests.subscribe;
        const count = yield* uiRequests.open({ threadId, target: { kind: "home" } });
        const request = yield* PubSub.take(subscription);
        NodeAssert.equal(request.threadId, threadId);
        NodeAssert.deepEqual(request.target, { kind: "home" });
        return count;
      }),
    );
    NodeAssert.equal(clients, 1);
    // A client that disconnected is no longer counted.
    NodeAssert.equal(yield* uiRequests.open({ threadId, target: { kind: "home" } }), 0);
  }).pipe(Effect.provide(UiRequests.layer)),
);
