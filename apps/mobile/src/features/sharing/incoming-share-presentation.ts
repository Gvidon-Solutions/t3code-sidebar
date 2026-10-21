export interface IncomingSharePresentationState {
  readonly presentedShareId: string | null;
  readonly dismissedShareId: string | null;
}

export interface IncomingSharePresentationTransition {
  readonly state: IncomingSharePresentationState;
  readonly shareIdToPresent: string | null;
}

export const EMPTY_INCOMING_SHARE_PRESENTATION_STATE: IncomingSharePresentationState = {
  presentedShareId: null,
  dismissedShareId: null,
};

export function transitionIncomingSharePresentation(
  state: IncomingSharePresentationState,
  input: {
    readonly isShareSheetPresented: boolean;
    readonly pendingShareId: string | null;
  },
): IncomingSharePresentationTransition {
  if (input.isShareSheetPresented) {
    if (input.pendingShareId === null || input.pendingShareId === state.presentedShareId) {
      // Consumption may happen while the sheet remains mounted. Forget the
      // old presentation immediately so a later handoff may reuse its id.
      return {
        state: input.pendingShareId === null ? EMPTY_INCOMING_SHARE_PRESENTATION_STATE : state,
        shareIdToPresent: null,
      };
    }
    if (state.dismissedShareId === input.pendingShareId) {
      return { state, shareIdToPresent: null };
    }
    // A new share while the new-task sheet is already open (a draft the user
    // started by hand) is routed into it instead of waiting unseen.
    return {
      state: { presentedShareId: input.pendingShareId, dismissedShareId: null },
      shareIdToPresent: input.pendingShareId,
    };
  }

  let nextState = state;
  if (state.presentedShareId !== null) {
    if (input.pendingShareId === state.presentedShareId) {
      return {
        state: {
          presentedShareId: null,
          dismissedShareId: state.presentedShareId,
        },
        shareIdToPresent: null,
      };
    }
    nextState = { ...state, presentedShareId: null };
  }

  if (input.pendingShareId === null) {
    return {
      state: EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
      shareIdToPresent: null,
    };
  }

  if (nextState.dismissedShareId === input.pendingShareId) {
    return { state: nextState, shareIdToPresent: null };
  }

  return {
    state: {
      presentedShareId: input.pendingShareId,
      dismissedShareId: null,
    },
    shareIdToPresent: input.pendingShareId,
  };
}
