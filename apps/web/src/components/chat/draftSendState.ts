import type { ThreadId } from "@t3tools/contracts";

let activeSends = 0;
const idleListeners = new Set<() => void>();
const states = new Map<
  string,
  {
    readonly sendInFlight: { current: boolean };
    readonly uncertainSubmissions: { current: Map<string, ThreadId> };
  }
>();

export function draftSendState(routeKey: string) {
  let state = states.get(routeKey);
  if (!state) {
    let sending = false;
    state = {
      sendInFlight: {
        get current() {
          return sending;
        },
        set current(value: boolean) {
          if (sending === value) return;
          sending = value;
          activeSends += value ? 1 : -1;
          if (activeSends === 0) {
            const listeners = [...idleListeners];
            idleListeners.clear();
            for (const listener of listeners) listener();
          }
        },
      },
      uncertainSubmissions: { current: new Map() },
    };
    states.set(routeKey, state);
  }
  return state;
}

// A send owns its cleared prompt until dispatch succeeds or restores the draft.
export function afterChatSendsSettled(listener: () => void) {
  if (activeSends === 0) listener();
  else idleListeners.add(listener);
  return () => {
    idleListeners.delete(listener);
  };
}
