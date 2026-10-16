import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  VOICE_THREAD_DEFAULT_TITLE,
  type ModelSelection,
  type ProjectId,
  type ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";

import { resolveSelectableModelSelection } from "../../lib/modelOptions";

/** Sidebar fork: the title of a thread started to talk, until its first phrase names it. */
export const VOICE_THREAD_TITLE = VOICE_THREAD_DEFAULT_TITLE;
/** Codex's realtime model, used when the draft's model cannot hold a conversation. */
export const VOICE_DEFAULT_MODEL = "gpt-6-astra";

function providerOf(config: T3ServerConfig, instanceId: ModelSelection["instanceId"]) {
  return config.providers.find((provider) => provider.instanceId === instanceId);
}

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
  if (!config) return null;
  if (
    draftSelection !== null &&
    providerOf(config, draftSelection.instanceId)?.supportsVoice === true &&
    resolveSelectableModelSelection(config, draftSelection, projectId) !== null
  ) {
    return draftSelection;
  }
  for (const provider of config.providers) {
    if (provider.supportsVoice !== true) continue;
    const model = provider.models.some((candidate) => candidate.slug === VOICE_DEFAULT_MODEL)
      ? VOICE_DEFAULT_MODEL
      : (provider.models.find((candidate) => candidate.isDefault)?.slug ??
        provider.models[0]?.slug ??
        VOICE_DEFAULT_MODEL);
    const selection = { instanceId: provider.instanceId, model };
    if (resolveSelectableModelSelection(config, selection, projectId) !== null) return selection;
  }
  return null;
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
