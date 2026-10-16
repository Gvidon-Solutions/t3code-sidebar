import * as NodeAssert from "node:assert/strict";

import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderThread,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as EventSink from "./EventSink.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as VoiceSessionService from "./VoiceSessionService.ts";

const threadId = "thread-voice" as ThreadId;
const instanceId = "codex" as ProviderInstanceId;
const epoch = DateTime.makeUnsafe(0);

interface Scenario {
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly resumeFails?: boolean;
}

/** Runs one voice start against fakes and reports what reached the provider and the log. */
const startVoice = (scenario: Scenario) =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const written: Array<OrchestrationV2DomainEvent> = [];
    let voiceThread: OrchestrationV2ProviderThread | undefined;
    const loaded = (
      row: OrchestrationV2ProviderThread,
      nativeId: string,
    ): OrchestrationV2ProviderThread => ({
      ...row,
      nativeThreadRef: { driver: "codex" as never, nativeId, strength: "strong" },
    });
    const runtime = {
      driver: "codex",
      instanceId,
      providerSession: { id: "provider-session-shared" },
      ensureThread: (input: { existingProviderThread: OrchestrationV2ProviderThread }) =>
        Effect.sync(() => {
          calls.push("ensureThread");
          return loaded(input.existingProviderThread, "native-new");
        }),
      resumeThread: (input: { providerThread: OrchestrationV2ProviderThread }) =>
        scenario.resumeFails === true
          ? Effect.sync(() => calls.push("resumeThread")).pipe(
              Effect.andThen(
                Effect.fail(
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: "codex" as never,
                    detail: "no rollout",
                  }),
                ),
              ),
            )
          : Effect.sync(() => {
              calls.push("resumeThread");
              return input.providerThread;
            }),
      startVoiceSession: (input: { providerThread: OrchestrationV2ProviderThread }) => {
        voiceThread = input.providerThread;
        return Stream.make({ type: "started" as const });
      },
    };
    const layer = VoiceSessionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(EventSink.EventSinkV2)({
            write: ({ events }) =>
              Effect.sync(() => {
                written.push(...events);
                return [];
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: threadId,
                  title: "Voice",
                  activeProviderThreadId: scenario.providerThreads[0]?.id ?? null,
                  modelSelection: { instanceId, model: "gpt-6-astra" },
                },
                providerThreads: scenario.providerThreads,
                providerSessions: [],
                runs: [],
              } as never),
          }),
          Layer.mock(ProviderAdapterRegistryV2)({
            get: () =>
              Effect.succeed({
                getCapabilities: () =>
                  Effect.succeed({
                    sessions: { supportsMultipleProviderThreadsPerSession: true },
                  }),
              } as never),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            open: () =>
              Effect.sync(() => {
                calls.push("open");
                return runtime as never;
              }),
            get: () => Effect.succeed(Option.none()),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({
            resolve: () => Effect.succeed({ cwd: null } as never),
          }),
        ),
      ),
    );
    const events = yield* Effect.gen(function* () {
      const voice = yield* VoiceSessionService.VoiceSessionServiceV2;
      return yield* Stream.runCollect(voice.start({ threadId, offerSdp: "v=offer\r\n" }));
    }).pipe(Effect.provide(layer));
    const recorded = written.find((event) => event.type === "provider-thread.updated")?.payload as
      | OrchestrationV2ProviderThread
      | undefined;
    return { calls, events: Array.from(events), recorded, voiceThread };
  });

const existingRow: OrchestrationV2ProviderThread = {
  id: "provider-thread-existing" as never,
  driver: "codex" as never,
  providerInstanceId: instanceId,
  providerSessionId: "provider-session-shared" as never,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver: "codex" as never, nativeId: "native-old", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 3,
  handoffIds: [],
  forkedFrom: null,
  createdAt: epoch,
  updatedAt: epoch,
};

it.effect("starts a thread that never ran and records it for the next run", () =>
  Effect.gen(function* () {
    const result = yield* startVoice({ providerThreads: [] });
    NodeAssert.deepEqual(result.calls, ["open", "ensureThread"]);
    NodeAssert.deepEqual(result.events, [{ type: "started" }]);
    // Recorded as a live root thread, so it becomes the thread's active one.
    NodeAssert.equal(result.recorded?.nativeThreadRef?.nativeId, "native-new");
    NodeAssert.notEqual(result.recorded?.providerSessionId, null);
    NodeAssert.equal(result.recorded?.ownerNodeId, null);
    NodeAssert.equal(result.voiceThread?.id, result.recorded?.id);
  }),
);

it.effect("resumes the thread's own native conversation", () =>
  Effect.gen(function* () {
    const result = yield* startVoice({ providerThreads: [existingRow] });
    NodeAssert.deepEqual(result.calls, ["open", "resumeThread"]);
    NodeAssert.equal(result.recorded?.id, existingRow.id);
    NodeAssert.equal(result.recorded?.nativeThreadRef?.nativeId, "native-old");
    NodeAssert.equal(result.recorded?.lastRunOrdinal, 3);
  }),
);

it.effect("replaces a native thread that cannot resume", () =>
  Effect.gen(function* () {
    const result = yield* startVoice({ providerThreads: [existingRow], resumeFails: true });
    NodeAssert.deepEqual(result.calls, ["open", "resumeThread", "ensureThread"]);
    NodeAssert.equal(result.recorded?.id, existingRow.id);
    NodeAssert.equal(result.recorded?.nativeThreadRef?.nativeId, "native-new");
  }),
);
