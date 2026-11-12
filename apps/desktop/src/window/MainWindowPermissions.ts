import * as Electron from "electron";

import { serverUiRendererId } from "../ipc/rendererTrust.ts";

export type MediaPermissionDecision = "grant" | "deny" | "ask-microphone";

/**
 * Whether `url` is the app shell: `appUrl`'s scheme and host (its query may carry
 * `?desktopWindowId=N`), or the server UI host minted for `rendererId`. Windows
 * share one session, so `rendererId` must come from the request.
 */
export function isAppUrl(
  url: string | undefined,
  appUrl: string,
  rendererId?: number | undefined,
): boolean {
  if (!url) return false;
  const app = URL.parse(appUrl);
  const target = URL.parse(url);
  if (app === null || target === null || app.host === "") return false;
  if (target.protocol !== app.protocol) return false;
  if (target.host === app.host) return true;
  return rendererId !== undefined && serverUiRendererId(target.host) === rendererId;
}

/**
 * Only the app shell's main frame gets media (voice, preview tab recording);
 * subframes such as MCP app frames never do. On macOS the microphone also
 * needs the system's consent, asked for on first use.
 */
export function decideMainWindowMediaRequest(input: {
  readonly requestingUrl: string;
  readonly appUrl: string;
  readonly rendererId?: number | undefined;
  readonly isMainFrame: boolean;
  readonly mediaTypes: ReadonlyArray<"audio" | "video">;
  readonly platform: NodeJS.Platform;
  readonly microphoneStatus: () => string;
}): MediaPermissionDecision {
  if (!input.isMainFrame) return "deny";
  if (!isAppUrl(input.requestingUrl, input.appUrl, input.rendererId)) return "deny";
  if (!input.mediaTypes.includes("audio") || input.platform !== "darwin") return "grant";
  return input.microphoneStatus() === "granted" ? "grant" : "ask-microphone";
}

/** Whether a media permission check (no prompt) passes for the app shell's main frame. */
export function allowMainWindowMediaCheck(input: {
  readonly requestingOrigin: string;
  readonly appUrl: string;
  readonly rendererId?: number | undefined;
  readonly isMainFrame: boolean;
}): boolean {
  return input.isMainFrame && isAppUrl(input.requestingOrigin, input.appUrl, input.rendererId);
}

/**
 * Installs the main window session's permission handlers. Only `media` is
 * decided here; every other permission keeps Electron's default of allowing
 * it, which is what this session did before it had handlers.
 */
export function installMainWindowPermissionHandlers(
  session: Electron.Session,
  options: { readonly appUrl: string; readonly platform: NodeJS.Platform },
): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "media") {
      callback(true);
      return;
    }
    const decision = decideMainWindowMediaRequest({
      requestingUrl: details.requestingUrl,
      appUrl: options.appUrl,
      rendererId: webContents.id,
      isMainFrame: details.isMainFrame,
      mediaTypes: "mediaTypes" in details ? (details.mediaTypes ?? []) : [],
      platform: options.platform,
      microphoneStatus: () => Electron.systemPreferences.getMediaAccessStatus("microphone"),
    });
    if (decision !== "ask-microphone") {
      callback(decision === "grant");
      return;
    }
    Electron.systemPreferences.askForMediaAccess("microphone").then(callback, () => {
      callback(false);
    });
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    permission === "media"
      ? allowMainWindowMediaCheck({
          requestingOrigin,
          appUrl: options.appUrl,
          rendererId: webContents?.id,
          isMainFrame: details.isMainFrame === true,
        })
      : true,
  );
}
