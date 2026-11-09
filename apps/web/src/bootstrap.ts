import { showBootError } from "./lib/bootError";
import {
  beginServerUiReconnect,
  clearServerUiReconnectAttempts,
  installServerUiReconnect,
  isChunkLoadFailure,
  isServerUiWindow,
} from "./lib/serverUiReconnect";

// Covers preload/chunk failures raised after the app starts.
installServerUiReconnect();

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void import("./main").then(
  ({ startup }) => {
    clearServerUiReconnectAttempts();
    return startup;
  },
  (error: unknown) => {
    if (isServerUiWindow() && isChunkLoadFailure(error)) {
      void beginServerUiReconnect();
      return;
    }
    showBootError(error);
  },
);
