import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  VOICE_THREAD_DEFAULT_TITLE,
  type ModelSelection,
  type ProjectId,
  type ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";

import { resolveVoiceThreadModelSelection } from "@t3tools/client-runtime/voice-availability";

/** Sidebar fork: the title of a thread started to talk, until its first phrase names it. */
export const VOICE_THREAD_TITLE = VOICE_THREAD_DEFAULT_TITLE;
/** Codex's realtime model, used when the draft's model cannot hold a conversation. */
export const VOICE_DEFAULT_MODEL = "gpt-6-astra";

/**
 * The model a voice thread starts with: the draft's own when its provider can
 * hold voice conversations, else the first such provider (Codex) on
 * `gpt-6-astra`, or its default model when the catalog lacks it. Null when the
 * environment has no usable voice provider for the project.
 */
export function resolveVoiceModelSelection(
  config: T3ServerConfig | null | undefined,
  draftSelection: ModelSelection | null,
  projectId: ProjectId | null,
): ModelSelection | null {
  // The shared rule is the one the composer and web use, so Home's Talk button
  // cannot offer a conversation the draft composer would hide.
  return resolveVoiceThreadModelSelection(config, draftSelection, projectId);
}

/**
 * Where Home's Talk button starts its thread: the open workspace's first
 * project that is not quiet, in the user's order, else its first project at
 * all; only projects on an environment that can hold a conversation count.
 * Null sends the caller to the "No project" folder.
 */
export function pickTalkProject(input: {
  readonly folders: ReadonlyArray<{
    readonly quiet: boolean;
    readonly projects: ReadonlyArray<EnvironmentProject>;
  }>;
  readonly canTalkIn: (project: EnvironmentProject) => boolean;
}): EnvironmentProject | null {
  const talkable = (folder: (typeof input.folders)[number]) =>
    folder.projects.find(input.canTalkIn) ?? null;
  for (const folder of input.folders) {
    if (folder.quiet) continue;
    const project = talkable(folder);
    if (project) return project;
  }
  for (const folder of input.folders) {
    const project = talkable(folder);
    if (project) return project;
  }
  return null;
}
