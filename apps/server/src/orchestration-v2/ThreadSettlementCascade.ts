/**
 * Fork: settling a thread settles its subagent threads, and un-settling it
 * un-settles them (FORK.md, "Settling a thread settles its agents").
 *
 * A reactor on committed domain events, so every way in cascades the same:
 * the settle button on any client, MCP and t3ctl, an agent settling its own
 * thread after its turn, and automatic settlement (`thread.auto-settle`
 * commits the same `thread.settled` event). Only the way down cascades;
 * settling or un-settling a child never touches its parent.
 */
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

export class ThreadSettlementCascadeV2 extends Context.Service<
  ThreadSettlementCascadeV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadSettlementCascade/ThreadSettlementCascadeV2") {}

interface Cascade {
  readonly direction: "settle" | "unsettle";
  readonly eventId: string;
  readonly threadId: ThreadId;
}

/** The parent event a cascade answers, or null for events that do not cascade. */
export function cascadeFor(event: OrchestrationV2DomainEvent): Cascade | null {
  if (event.type === "thread.settled") {
    return { direction: "settle", eventId: event.id, threadId: event.threadId };
  }
  // The un-settle button leaves an explicit "active" override. A new turn on
  // a settled thread also commits thread.unsettled, with no override: the
  // parent is working again, but the agents it ran before stay done.
  if (event.type === "thread.unsettled" && event.payload.settledOverride === "active") {
    return { direction: "unsettle", eventId: event.id, threadId: event.threadId };
  }
  return null;
}

function childThreadIds(subagents: ReadonlyArray<OrchestrationV2Subagent>): Array<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const subagent of subagents) {
    if (subagent.childThreadId !== null) ids.add(subagent.childThreadId);
  }
  return [...ids];
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;

  /**
   * Walks the subagent threads under the event's thread, depth first. A
   * child not yet in the target state gets one command, with an id derived
   * from the parent event so a replayed event dispatches nothing twice; its
   * own committed event then carries the cascade to its children. A child
   * already in the target state is walked through here, so a grandchild left
   * behind earlier still follows. A child that refuses (still running,
   * waiting on an approval, a queued message) keeps itself and its subtree
   * as they are; the rest carry on.
   */
  const cascade = Effect.fn("ThreadSettlementCascadeV2.cascade")(function* (input: Cascade) {
    const visited = new Set<ThreadId>([input.threadId]);
    const walk: (parentId: ThreadId) => Effect.Effect<void> = Effect.fn(
      "ThreadSettlementCascadeV2.walk",
    )(
      function* (parentId: ThreadId) {
        const { subagents } = yield* orchestrator.getThreadRecords(parentId, ["subagents"]);
        for (const childId of childThreadIds(subagents)) {
          if (visited.has(childId)) continue;
          visited.add(childId);
          yield* visit(parentId, childId);
        }
      },
      (effect, parentId) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("settlement cascade could not read subagent threads", {
                  threadId: parentId,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
    );

    const visit: (parentId: ThreadId, childId: ThreadId) => Effect.Effect<void> = Effect.fn(
      "ThreadSettlementCascadeV2.visit",
    )(
      function* (parentId: ThreadId, childId: ThreadId) {
        const { thread: child } = yield* orchestrator.getThreadRecords(childId, []);
        // Subagent records can be copied into forks; only the thread's own
        // lineage makes it a child. Archived and deleted threads stay put.
        if (
          child.lineage.parentThreadId !== parentId ||
          child.lineage.relationshipToParent !== "subagent" ||
          child.archivedAt !== null ||
          child.deletedAt !== null
        ) {
          return;
        }
        const reached =
          input.direction === "settle"
            ? child.settledOverride === "settled"
            : child.settledOverride !== "settled";
        if (reached) return yield* walk(childId);
        const commandId = CommandId.make(
          `server:settlement-cascade:${input.eventId}:${input.direction}:${childId}`,
        );
        yield* orchestrator.dispatch(
          input.direction === "settle"
            ? { type: "thread.settle", commandId, threadId: childId }
            : { type: "thread.unsettle", commandId, threadId: childId, reason: "user" },
        );
      },
      (effect, parentId, childId) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logInfo("subagent thread left as it was by the settlement cascade", {
                  parentThreadId: parentId,
                  threadId: childId,
                  direction: input.direction,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
    );

    yield* walk(input.threadId);
  });

  const worker = yield* makeDrainableWorker(cascade);

  const start: ThreadSettlementCascadeV2["Service"]["start"] = Effect.fn(
    "ThreadSettlementCascadeV2.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        const next = cascadeFor(event);
        return next === null ? Effect.void : worker.enqueue(next);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread settlement cascade event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadSettlementCascadeV2["Service"];
});

export const layer = Layer.effect(ThreadSettlementCascadeV2, make);
