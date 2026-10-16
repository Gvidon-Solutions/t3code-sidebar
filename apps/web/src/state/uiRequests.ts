import { createUiRequestAtoms } from "@t3tools/client-runtime/state/ui-requests";
import type { EnvironmentId, UiRequest, VoiceCommand } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "./presentation";

/** Fork: agents asking this client to show something (`ui_open`). */
export const uiRequestAtoms = createUiRequestAtoms(connectionAtomRuntime);

export interface EnvironmentUiRequest {
  readonly environmentId: EnvironmentId;
  /** The latest request since this client subscribed; null before the first. */
  readonly request: UiRequest | null;
}

/**
 * Every connected environment's latest request. Reading it keeps one
 * subscription per connected environment open; an older server without the
 * stream never yields a request.
 */
export const latestUiRequestsAtom = Atom.make((get): ReadonlyArray<EnvironmentUiRequest> =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).map((environmentId) => ({
    environmentId,
    request: Option.getOrNull(
      AsyncResult.value(get(uiRequestAtoms.latestUiRequest({ environmentId, input: {} }))),
    ),
  })),
).pipe(Atom.withLabel("web-ui-requests-latest"));

export interface EnvironmentVoiceCommand {
  readonly environmentId: EnvironmentId;
  /** The latest voice command since this client subscribed; null before the first. */
  readonly request: VoiceCommand | null;
}

/** Fork: every connected environment's latest spoken command for a voice conversation. */
export const latestVoiceCommandsAtom = Atom.make((get): ReadonlyArray<EnvironmentVoiceCommand> =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).map((environmentId) => ({
    environmentId,
    request: Option.getOrNull(
      AsyncResult.value(get(uiRequestAtoms.latestVoiceCommand({ environmentId, input: {} }))),
    ),
  })),
).pipe(Atom.withLabel("web-voice-commands-latest"));
