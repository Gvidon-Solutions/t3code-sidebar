/**
 * Starts voice conversations on a thread. Codex needs a loaded native thread, so one is started or
 * resumed here without a user turn and recorded like a run would. Fork: it keeps what was said so
 * `carryOver` can start the next thread's conversation with it, and waits for a preparing thread.
 */
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  ProviderVoiceSessionError,
  type ProviderVoiceSessionEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { VoiceInitialItem } from "@t3tools/provider-core/server/ProviderAdapter";

import * as EventSink from "./EventSink.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";

export interface VoiceSessionServiceV2Shape {
  /** The conversation's signaling stream; interrupting it stops the conversation. */
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly offerSdp: string;
  }) => Stream.Stream<ProviderVoiceSessionEvent, ProviderVoiceSessionError>;
  /** Whether a voice conversation is live on the thread. */
  readonly isLive: (threadId: ThreadId) => Effect.Effect<boolean>;
  /**
   * Carries the live conversation on `from` over to `to`: a conversation
   * started on `to` within a few minutes begins with what was said. False
   * when no conversation is live on `from`.
   */
  readonly carryOver: (input: {
    readonly from: ThreadId;
    readonly fromTitle: string;
    readonly to: ThreadId;
  }) => Effect.Effect<boolean>;
  /** Waits up to a minute for the thread to finish preparing; false if it never did. */
  readonly whenReady: (threadId: ThreadId) => Effect.Effect<boolean>;
}

export class VoiceSessionServiceV2 extends Context.Service<
  VoiceSessionServiceV2,
  VoiceSessionServiceV2Shape
>()("t3/orchestration-v2/VoiceSessionService/VoiceSessionServiceV2") {}

// Realtime v3 takes up to 128 starting items and about 8k tokens of them.
const MAX_CARRIED_ITEMS = 60;
const MAX_CARRIED_CHARS = 12_000;
const CARRY_OVER_TTL_MS = 3 * 60 * 1000;
/** Seconds a call waits for a thread still preparing or starting; clients give up at 20. */
const START_READY_WAIT_TIMES = 12;
/** Seconds a move waits for its target before sending the device there. */
const MOVE_READY_WAIT_TIMES = 60;

interface LiveConversation {
  readonly id: number;
  readonly transcript: Array<VoiceInitialItem>;
}

interface CarriedConversation {
  readonly items: ReadonlyArray<VoiceInitialItem>;
  readonly expiresAtMs: number;
}

/** The newest lines that fit the carry-over budget, oldest first. */
export function trimCarriedTranscript(
  transcript: ReadonlyArray<VoiceInitialItem>,
): ReadonlyArray<VoiceInitialItem> {
  const kept: Array<VoiceInitialItem> = [];
  let chars = 0;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index]!;
    if (kept.length >= MAX_CARRIED_ITEMS || chars + item.text.length > MAX_CARRIED_CHARS) break;
    kept.unshift(item);
    chars += item.text.length;
  }
  return kept;
}

/** The note that opens a carried conversation, ahead of its lines. */
export function carriedConversationNote(fromTitle: string): VoiceInitialItem {
  return {
    role: "developer",
    text: `The owner moved this voice conversation here from the thread "${fromTitle}". The lines that follow were said there. Continue from them without repeating them, and keep the same language.`,
  };
}

/** A thread that is still preparing or starting; voice waits for it. */
class VoiceThreadNotReady extends Data.TaggedError("VoiceThreadNotReady")<{
  readonly detail: string;
}> {}

const isLiveRun = (run: OrchestrationV2Run) =>
  run.status === "starting" || run.status === "running" || run.status === "waiting";

function describe(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    if ("detail" in cause && typeof cause.detail === "string") return cause.detail;
    if ("message" in cause && typeof cause.message === "string") return cause.message;
  }
  return String(cause);
}

export const layer = Layer.effect(
  VoiceSessionServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const titles = yield* ThreadTitleRegenerationService.ThreadTitleRegenerationService;
    const providerAdapters = yield* ProviderAdapterRegistryV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;

    /** The thread's provider thread, loaded in a live session, ready for realtime. */
    const prepare = Effect.fn("orchestrationV2.voiceSession.prepare")(function* (
      threadId: ThreadId,
    ) {
      const fail = (detail: string) => new ProviderVoiceSessionError({ threadId, detail });
      const projection = yield* projectionStore.getThreadRecords(threadId, [
        "providerThreads",
        "providerSessions",
        "runs",
      ]);
      const existing =
        projection.providerThreads.find(
          (candidate) => candidate.id === projection.thread.activeProviderThreadId,
        ) ?? projection.providerThreads.findLast((candidate) => candidate.ownerNodeId === null);
      const liveRun = projection.runs.find(isLiveRun);
      if (liveRun !== undefined) {
        // A running turn already has its native thread loaded.
        const running = projection.providerThreads.find(
          (candidate) => candidate.id === liveRun.providerThreadId,
        );
        if (running?.providerSessionId != null && running.nativeThreadRef !== null) {
          const runtime = yield* providerSessions.get(running.providerSessionId);
          if (Option.isSome(runtime)) return { runtime: runtime.value, providerThread: running };
        }
        return yield* new VoiceThreadNotReady({
          detail: "This thread is still starting. Try voice again in a moment.",
        });
      }
      if (projection.runs.some((run) => run.status === "preparing")) {
        return yield* new VoiceThreadNotReady({
          detail: "This thread is still preparing its workspace. Try again in a moment.",
        });
      }

      const modelSelection =
        existing === undefined ||
        existing.providerInstanceId === projection.thread.modelSelection.instanceId
          ? projection.thread.modelSelection
          : undefined;
      if (modelSelection === undefined) {
        return yield* fail("Send a message to switch this thread's provider before using voice.");
      }
      const adapter = yield* providerAdapters.get(modelSelection.instanceId);
      const capabilities = yield* adapter.getCapabilities();
      const providerSessionId =
        existing?.providerSessionId ??
        (capabilities.sessions.supportsMultipleProviderThreadsPerSession
          ? idAllocator.derive.providerSession({ providerInstanceId: modelSelection.instanceId })
          : yield* idAllocator.allocate.providerSession({
              providerInstanceId: modelSelection.instanceId,
              threadId,
            }));
      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection,
      });
      const existingSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const session = yield* providerSessions.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
        ...(existing?.nativeThreadRef?.nativeId == null
          ? {}
          : { initialNativeThreadId: existing.nativeThreadRef.nativeId }),
      });
      if (session.startVoiceSession === undefined) {
        return yield* fail(`Provider '${session.driver}' does not support voice conversations.`);
      }
      const now = yield* DateTime.now;
      // A fresh row reuses the run path's shape so the next run adopts it.
      const row: OrchestrationV2ProviderThread = existing ?? {
        id: idAllocator.derive.providerThread({
          driver: session.driver,
          nativeThreadId: `pending:voice:${threadId}:${DateTime.toEpochMillis(now)}`,
        }),
        driver: session.driver,
        providerInstanceId: modelSelection.instanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const ensureInput = {
        threadId,
        title: projection.thread.title,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        providerSessionId,
      };
      const loaded =
        row.nativeThreadRef === null
          ? yield* session.ensureThread({ ...ensureInput, existingProviderThread: row })
          : yield* session
              .resumeThread({
                providerThread: row,
                threadId,
                modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
              })
              .pipe(
                // A native thread that cannot resume (deleted rollout, never
                // persisted) is replaced, as a run's resume fallback does.
                Effect.catch(() =>
                  session.ensureThread({
                    ...ensureInput,
                    existingProviderThread: { ...row, nativeThreadRef: null },
                  }),
                ),
              );
      const providerThread: OrchestrationV2ProviderThread = {
        ...loaded,
        id: row.id,
        driver: session.driver,
        providerInstanceId: modelSelection.instanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        firstRunOrdinal: row.firstRunOrdinal,
        lastRunOrdinal: row.lastRunOrdinal,
        handoffIds: row.handoffIds,
        forkedFrom: row.forkedFrom,
        status: "idle",
        createdAt: row.createdAt,
        updatedAt: now,
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
          type: "provider-session.updated",
          threadId,
          driver: session.driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: session.providerSession,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId }),
          type: "provider-thread.updated",
          threadId,
          driver: session.driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: providerThread,
        },
      ];
      yield* eventSink.write({ events });
      return { runtime: session, providerThread };
    });

    const live = yield* Ref.make<ReadonlyMap<ThreadId, LiveConversation>>(new Map());
    const carried = yield* Ref.make<ReadonlyMap<ThreadId, CarriedConversation>>(new Map());
    const nextConversationId = yield* Ref.make(0);

    /** Takes what a conversation carried to the thread, if it is still fresh. */
    const takeCarried = Effect.fn("VoiceSessionServiceV2.takeCarried")(function* (
      threadId: ThreadId,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const entry = yield* Ref.modify(carried, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return [current.get(threadId), next];
      });
      return entry !== undefined && entry.expiresAtMs > now ? entry.items : [];
    });

    const isLive: VoiceSessionServiceV2Shape["isLive"] = (threadId) =>
      Effect.map(Ref.get(live), (current) => current.has(threadId));

    const carryOver: VoiceSessionServiceV2Shape["carryOver"] = Effect.fn(
      "VoiceSessionServiceV2.carryOver",
    )(function* ({ from, fromTitle, to }) {
      const conversation = (yield* Ref.get(live)).get(from);
      if (conversation === undefined) return false;
      const now = yield* Clock.currentTimeMillis;
      const items = [
        carriedConversationNote(fromTitle),
        ...trimCarriedTranscript(conversation.transcript),
      ];
      yield* Ref.update(carried, (current) =>
        new Map(current).set(to, { items, expiresAtMs: now + CARRY_OVER_TTL_MS }),
      );
      return true;
    });

    const isBusy = (threadId: ThreadId) =>
      projectionStore
        .getThreadRecords(threadId, ["runs"])
        .pipe(
          Effect.map(({ runs }) =>
            runs.some((run) => run.status === "preparing" || run.status === "starting"),
          ),
        );

    const whenReady: VoiceSessionServiceV2Shape["whenReady"] = Effect.fn(
      "VoiceSessionServiceV2.whenReady",
    )(
      function* (threadId) {
        for (let attempt = 0; ; attempt += 1) {
          if (!(yield* isBusy(threadId))) return true;
          if (attempt >= MOVE_READY_WAIT_TIMES) return false;
          yield* Effect.sleep("1 second");
        }
      },
      Effect.orElseSucceed(() => false),
    );

    const start: VoiceSessionServiceV2Shape["start"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { runtime, providerThread } = yield* prepare(input.threadId).pipe(
            Effect.retry({
              while: (error) => error._tag === "VoiceThreadNotReady",
              schedule: Schedule.spaced("1 second"),
              times: START_READY_WAIT_TIMES,
            }),
            Effect.catchTags({
              VoiceThreadNotReady: (error) =>
                Effect.fail(
                  new ProviderVoiceSessionError({ threadId: input.threadId, detail: error.detail }),
                ),
            }),
          );
          if (runtime.startVoiceSession === undefined) {
            return yield* new ProviderVoiceSessionError({
              threadId: input.threadId,
              detail: `Provider '${runtime.driver}' does not support voice conversations.`,
            });
          }
          const named = yield* Ref.make(false);
          const initialItems = yield* takeCarried(input.threadId);
          // A carried conversation keeps its lines, so moving it again keeps them too.
          const conversation: LiveConversation = {
            id: yield* Ref.updateAndGet(nextConversationId, (value) => value + 1),
            transcript: initialItems.filter((item) => item.role !== "developer"),
          };
          yield* Ref.update(live, (current) => new Map(current).set(input.threadId, conversation));
          return runtime
            .startVoiceSession({
              providerThread,
              offerSdp: input.offerSdp,
              ...(initialItems.length > 0 ? { initialItems } : {}),
            })
            .pipe(
              Stream.tap((event) =>
                event.type === "transcript.done" && event.text.trim()
                  ? Effect.sync(() => {
                      conversation.transcript.push({ role: event.role, text: event.text.trim() });
                      // Only the newest lines are ever carried; a long talk drops the rest.
                      if (conversation.transcript.length > MAX_CARRIED_ITEMS * 2) {
                        conversation.transcript.splice(0, MAX_CARRIED_ITEMS);
                      }
                    })
                  : Effect.void,
              ),
              // A newer conversation on the thread must keep its own entry.
              Stream.ensuring(
                Ref.update(live, (current) => {
                  if (current.get(input.threadId) !== conversation) return current;
                  const next = new Map(current);
                  next.delete(input.threadId);
                  return next;
                }),
              ),
              Stream.tap((event) =>
                event.type === "transcript.done" && event.role === "user" && event.text.trim()
                  ? Ref.getAndSet(named, true).pipe(
                      Effect.flatMap((alreadyNamed) =>
                        alreadyNamed
                          ? Effect.void
                          : titles
                              .nameFromSpeech({ threadId: input.threadId, text: event.text })
                              .pipe(
                                Effect.ignoreCause({ log: true }),
                                Effect.forkDetach,
                                Effect.asVoid,
                              ),
                      ),
                    )
                  : Effect.void,
              ),
            );
        }),
      ).pipe(
        Stream.mapError((cause) =>
          cause._tag === "ProviderVoiceSessionError"
            ? cause
            : new ProviderVoiceSessionError({
                threadId: input.threadId,
                detail: describe(cause),
                cause,
              }),
        ),
      );

    return { start, isLive, carryOver, whenReady } satisfies VoiceSessionServiceV2Shape;
  }),
);
