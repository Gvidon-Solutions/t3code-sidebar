/**
 * Starts voice conversations on a thread. Codex attaches realtime to a loaded
 * native thread, so a thread that has never run, or whose provider session went
 * away (server restart, idle release), gets one here first: the session is
 * opened and the native thread started or resumed without a user turn. The
 * provider thread is recorded like a run would record it, so the thread's next
 * run continues the same native conversation the voice talks into.
 */
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  ProviderVoiceSessionError,
  type ProviderVoiceSessionEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as EventSink from "./EventSink.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

export interface VoiceSessionServiceV2Shape {
  /** The conversation's signaling stream; interrupting it stops the conversation. */
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly offerSdp: string;
  }) => Stream.Stream<ProviderVoiceSessionEvent, ProviderVoiceSessionError>;
}

export class VoiceSessionServiceV2 extends Context.Service<
  VoiceSessionServiceV2,
  VoiceSessionServiceV2Shape
>()("t3/orchestration-v2/VoiceSessionService/VoiceSessionServiceV2") {}

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
        return yield* fail("This thread is still starting. Try voice again in a moment.");
      }
      if (projection.runs.some((run) => run.status === "preparing")) {
        return yield* fail("This thread is still preparing its workspace. Try again in a moment.");
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

    const start: VoiceSessionServiceV2Shape["start"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { runtime, providerThread } = yield* prepare(input.threadId);
          if (runtime.startVoiceSession === undefined) {
            return yield* new ProviderVoiceSessionError({
              threadId: input.threadId,
              detail: `Provider '${runtime.driver}' does not support voice conversations.`,
            });
          }
          return runtime.startVoiceSession({ providerThread, offerSdp: input.offerSdp });
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

    return { start } satisfies VoiceSessionServiceV2Shape;
  }),
);
