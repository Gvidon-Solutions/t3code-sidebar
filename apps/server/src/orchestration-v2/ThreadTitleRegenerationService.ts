import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  VOICE_THREAD_DEFAULT_TITLE,
  type ChatAttachment,
  type MessageId,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
export { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";

export class ThreadTitleRegenerationService extends Context.Service<
  ThreadTitleRegenerationService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly kind:
        | { readonly type: "initial"; readonly messageId: MessageId }
        | { readonly type: "regenerate" };
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
    /**
     * Fork: names a thread still titled `VOICE_THREAD_DEFAULT_TITLE` after
     * the first phrase spoken in it, the way a first message names a thread.
     * Falls back to the phrase itself; leaves a renamed thread alone.
     */
    readonly nameFromSpeech: (input: {
      readonly threadId: ThreadId;
      readonly text: string;
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/ThreadTitleRegenerationService") {}

/** Longest spoken phrase used as a title as is. */
const SPOKEN_TITLE_MAX_CHARS = 60;

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const complete = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) =>
    threads
      .dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make(`${input.requestId}:title-complete`),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.title === undefined ? {} : { title: input.title }),
      })
      .pipe(Effect.asVoid);

  const execute: ThreadTitleRegenerationService["Service"]["execute"] = Effect.fn(
    "ThreadTitleRegenerationService.execute",
  )(function* (input) {
    const outcome:
      | { readonly type: "stale" }
      | { readonly type: "complete"; readonly title?: string } = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(
        input.threadId,
        ["messages"],
        input.kind.type === "initial"
          ? { messageIds: [input.kind.messageId] }
          : { messageRoles: ["user", "assistant"] },
      );
      if (projection.thread.titleRegeneration?.requestId !== input.requestId) {
        return { type: "stale" as const };
      }

      const project = yield* projects.get(projection.thread.projectId);
      if (Option.isNone(project)) {
        return { type: "complete" as const };
      }

      let context: {
        readonly message: string;
        readonly attachments: ReadonlyArray<ChatAttachment>;
      };
      if (input.kind.type === "initial") {
        const messageId = input.kind.messageId;
        const message = projection.messages.find(
          (candidate) => candidate.id === messageId && !candidate.streaming,
        );
        context =
          message === undefined
            ? { message: "", attachments: [] }
            : { message: message.text, attachments: message.attachments };
      } else {
        context = formatThreadTitleContext(
          projection.messages.filter((message) => !message.streaming),
        );
      }
      if (context.message.length === 0 && context.attachments.length === 0) {
        return { type: "complete" as const };
      }

      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projection.thread.projectId,
      ).settings;
      const result = yield* textGeneration.generateThreadTitle({
        cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
        message: context.message,
        attachments: context.attachments,
        ...(input.kind.type === "regenerate" ? { previousTitle: projection.thread.title } : {}),
        modelSelection: settings.textGenerationModelSelection,
      });
      const generatedTitle = result.title.trim();
      return generatedTitle === "New thread" ||
        (input.kind.type === "regenerate" && generatedTitle === projection.thread.title.trim())
        ? { type: "complete" as const }
        : { type: "complete" as const, title: result.title };
    }).pipe(
      Effect.retry({
        times: input.kind.type === "initial" ? 2 : 0,
        schedule: Schedule.exponential("2 seconds"),
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread title generation failed", {
              threadId: input.threadId,
              requestId: input.requestId,
              cause,
            }).pipe(Effect.as({ type: "complete" as const })),
      ),
    );

    if (outcome.type === "stale") {
      return;
    }
    yield* complete({
      ...input,
      ...(outcome.title === undefined ? {} : { title: outcome.title }),
    });
  });

  const nameFromSpeech: ThreadTitleRegenerationService["Service"]["nameFromSpeech"] = Effect.fn(
    "ThreadTitleRegenerationService.nameFromSpeech",
  )(function* (input) {
    const unnamedThread = threads
      .getThreadRecords(input.threadId, [])
      .pipe(
        Effect.map((projection) =>
          projection.thread.title === VOICE_THREAD_DEFAULT_TITLE ? projection.thread : null,
        ),
      );
    const thread = yield* unnamedThread;
    const phrase = input.text.trim().replace(/\s+/g, " ");
    if (thread === null || phrase.length === 0) return;
    const fallback =
      phrase.length > SPOKEN_TITLE_MAX_CHARS
        ? `${phrase.slice(0, SPOKEN_TITLE_MAX_CHARS).trimEnd()}…`
        : phrase;

    const project = yield* projects.get(thread.projectId);
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      thread.projectId,
    ).settings;
    const generated = Option.isNone(project)
      ? fallback
      : yield* textGeneration
          .generateThreadTitle({
            cwd: thread.worktreePath ?? project.value.workspaceRoot,
            message: phrase,
            attachments: [],
            modelSelection: settings.textGenerationModelSelection,
          })
          .pipe(
            Effect.map((result) => result.title.trim()),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("Voice thread title generation failed", {
                    threadId: input.threadId,
                    cause,
                  }).pipe(Effect.as(fallback)),
            ),
          );
    const title = generated.length === 0 || generated === "New thread" ? fallback : generated;
    // The owner may have renamed it while the title was generated.
    if ((yield* unnamedThread) === null) return;
    yield* threads.dispatch({
      type: "thread.metadata.update",
      // One spoken name per thread: a retry replays this receipt.
      commandId: CommandId.make(`voice-title:${input.threadId}`),
      threadId: input.threadId,
      title,
    });
  });

  return ThreadTitleRegenerationService.of({ execute, nameFromSpeech });
});

export const layer = Layer.effect(ThreadTitleRegenerationService, make);
