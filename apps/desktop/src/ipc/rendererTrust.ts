import type { DesktopIpcInvokeEvent } from "./DesktopIpc.ts";
import * as Channels from "./channels.ts";

const serverChannels = new Set([
  Channels.UI_INFO_CHANNEL,
  Channels.UI_SERVER_ORIGIN_CHANNEL,
  Channels.GET_APP_BRANDING_CHANNEL,
  Channels.GET_SYSTEM_LOCALE_CHANNEL,
  Channels.REVEAL_WINDOW_CHANNEL,
]);

export function authorizeDesktopIpc(
  event: DesktopIpcInvokeEvent,
  channel: string,
  currentUrl: string | undefined,
): void {
  const frame = event.senderFrame;
  const url = frame ? URL.parse(frame.url) : null;
  if (
    !url ||
    !currentUrl ||
    frame?.parent !== null ||
    frame.url !== currentUrl ||
    !["t3code:", "t3code-dev:"].includes(url.protocol) ||
    (url.host !== "app" &&
      !(url.host === `server-${event.sender.id}` && serverChannels.has(channel)))
  )
    throw new Error("Desktop IPC denied for this frame and UI origin");
}
