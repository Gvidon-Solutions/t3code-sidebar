import { showBootError } from "./lib/bootError";
import {
  beginServerUiReconnect,
  installHealthyReconnectReset,
  installServerUiReconnect,
  isChunkLoadFailure,
  isServerUiWindow,
} from "./lib/serverUiReconnect";

// Covers preload/chunk failures raised after the app starts.
installServerUiReconnect();

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void import("./main").then(
  ({ startup }) => {
    // A successful import is not a healthy mount; keep the reload budget until then.
    installHealthyReconnectReset();
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
