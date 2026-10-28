import * as NodeAssert from "node:assert/strict";

import type {
  ProviderVoiceSessionEvent,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderThread,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as EventSink from "./EventSink.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as VoiceSessionService from "./VoiceSessionService.ts";

const threadId = "thread-voice" as ThreadId;
const instanceId = "codex" as ProviderInstanceId;
const epoch = DateTime.makeUnsafe(0);

interface Scenario {
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly resumeFails?: boolean;
  /** What the conversation streams after it starts. */
  readonly conversation?: ReadonlyArray<ProviderVoiceSessionEvent>;
  /** Keeps every conversation open until it completes. */
  readonly hold?: Deferred.Deferred<void>;
  /** Completes once a held conversation has streamed everything before the hold. */
  readonly held?: Deferred.Deferred<void>;
  /** The thread's runs, for readiness. */
  readonly runs?: () => ReadonlyArray<{ readonly status: string }>;
}

/** The voice service over fakes, with what reached the provider and the log. */
const makeHarness = (scenario: Scenario) =>
  Effect.gen(function* () {
    const startInputs: Array<{ readonly initialItems?: ReadonlyArray<unknown> }> = [];
    const calls: Array<string> = [];
    const written: Array<OrchestrationV2DomainEvent> = [];
    const spokenNames = yield* Queue.unbounded<string>();
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
      startVoiceSession: (input: {
        providerThread: OrchestrationV2ProviderThread;
        initialItems?: ReadonlyArray<unknown>;
      }) => {
        voiceThread = input.providerThread;
        startInputs.push(input);
        const events = Stream.fromIterable<ProviderVoiceSessionEvent>([
          { type: "started" },
          ...(scenario.conversation ?? []),
        ]);
        const hold = scenario.hold;
        return hold === undefined
          ? events
          : Stream.concat(
              events,
              Stream.drain(
                Stream.fromEffect(
                  (scenario.held ? Deferred.succeed(scenario.held, undefined) : Effect.void).pipe(
                    Effect.andThen(Deferred.await(hold)),
                  ),
                ),
              ),
            );
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
                runs: scenario.runs?.() ?? [],
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
            get: () => Effect.succeedNone,
          }),
          Layer.mock(ThreadTitleRegenerationService.ThreadTitleRegenerationService)({
            nameFromSpeech: ({ text }) => Queue.offer(spokenNames, text).pipe(Effect.asVoid),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({
            resolve: () => Effect.succeed({ cwd: null } as never),
          }),
        ),
      ),
    );
    return {
      layer,
      calls,
      written,
      spokenNames,
      startInputs,
      voiceThread: () => voiceThread,
    };
  });

/** Runs one voice start against fakes and reports what reached the provider and the log. */
const startVoice = (scenario: Scenario) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(scenario);
    const events = yield* Effect.gen(function* () {
      const voice = yield* VoiceSessionService.VoiceSessionServiceV2;
      return yield* Stream.runCollect(voice.start({ threadId, offerSdp: "v=offer\r\n" }));
    }).pipe(Effect.provide(harness.layer));
    const recorded = harness.written.find((event) => event.type === "provider-thread.updated")
      ?.payload as OrchestrationV2ProviderThread | undefined;
    return {
      calls: harness.calls,
      events: Array.from(events),
      recorded,
      voiceThread: harness.voiceThread(),
      spokenNames: harness.spokenNames,
    };
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

it.effect("names the thread once, after the first phrase the owner says", () =>
  Effect.gen(function* () {
    const result = yield* startVoice({
      providerThreads: [existingRow],
      conversation: [
        { type: "transcript.done", role: "assistant", text: "Hi, how can I help?" },
        { type: "transcript.done", role: "user", text: " " },
        { type: "transcript.done", role: "user", text: "Plan the release" },
        { type: "transcript.done", role: "user", text: "And the changelog" },
      ],
    });
    // Naming runs detached so captions never wait for it.
    NodeAssert.equal(yield* Queue.take(result.spokenNames), "Plan the release");
    yield* Effect.yieldNow;
    NodeAssert.equal(yield* Queue.size(result.spokenNames), 0);
  }),
);

it("carries only the newest lines that fit", () => {
  const lines = Array.from({ length: 100 }, (_, index) => ({
    role: "user" as const,
    text: `line ${index}`,
  }));
  const kept = VoiceSessionService.trimCarriedTranscript(lines);
  NodeAssert.equal(kept.length, 60);
  NodeAssert.equal(kept.at(-1)?.text, "line 99");
  const long = [
    { role: "user" as const, text: "a".repeat(8_000) },
    { role: "assistant" as const, text: "b".repeat(8_000) },
  ];
  NodeAssert.deepEqual(
    VoiceSessionService.trimCarriedTranscript(long).map((line) => line.role),
    ["assistant"],
  );
});

it.effect("starts a moved conversation with what was said before", () =>
  Effect.gen(function* () {
    const hold = yield* Deferred.make<void>();
    const held = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      providerThreads: [existingRow],
      hold,
      held,
      conversation: [
        { type: "transcript.done", role: "user", text: "Plan the release" },
        { type: "transcript.done", role: "assistant", text: "Friday works." },
      ],
    });
    const target = "thread-next" as ThreadId;
    yield* Effect.gen(function* () {
      const voice = yield* VoiceSessionService.VoiceSessionServiceV2;
      NodeAssert.equal(
        yield* voice.carryOver({ from: threadId, fromTitle: "Release", to: target }),
        false,
      );
      const first = yield* Stream.runDrain(voice.start({ threadId, offerSdp: "v=offer\r\n" })).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(held);
      NodeAssert.equal(
        yield* voice.carryOver({ from: threadId, fromTitle: "Release", to: target }),
        true,
      );
      yield* Deferred.succeed(hold, undefined);
      yield* Fiber.join(first);
      NodeAssert.equal(yield* voice.isLive(threadId), false);
      yield* Stream.runDrain(voice.start({ threadId: target, offerSdp: "v=offer\r\n" }));
      // Taken once: a later call there starts fresh.
      yield* Stream.runDrain(voice.start({ threadId: target, offerSdp: "v=offer\r\n" }));
    }).pipe(Effect.provide(harness.layer));
    NodeAssert.equal(harness.startInputs[0]?.initialItems, undefined);
    NodeAssert.deepEqual(harness.startInputs[1]?.initialItems, [
      VoiceSessionService.carriedConversationNote("Release"),
      { role: "user", text: "Plan the release" },
      { role: "assistant", text: "Friday works." },
    ]);
    NodeAssert.equal(harness.startInputs[2]?.initialItems, undefined);
  }),
);

it.effect("waits for a thread that is still preparing", () =>
  Effect.gen(function* () {
    let polls = 0;
    const harness = yield* makeHarness({
      providerThreads: [existingRow],
      runs: () => (++polls < 3 ? [{ status: "preparing" }] : [{ status: "completed" }]),
    });
    yield* Effect.gen(function* () {
      const voice = yield* VoiceSessionService.VoiceSessionServiceV2;
      const ready = yield* voice.whenReady(threadId).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      NodeAssert.equal(yield* Fiber.join(ready), true);
    }).pipe(Effect.provide(harness.layer));
    NodeAssert.equal(polls, 3);
  }),
);
