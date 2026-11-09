import type { DesktopIpcInvokeEvent } from "./DesktopIpc.ts";
import * as Channels from "./channels.ts";

const serverChannels = new Set([
  Channels.UI_INFO_CHANNEL,
  Channels.UI_SELECT_CHANNEL,
  Channels.UI_SERVER_ORIGIN_CHANNEL,
  Channels.UI_SERVER_NAME_CHANNEL,
  Channels.GET_APP_BRANDING_CHANNEL,
  Channels.GET_SYSTEM_LOCALE_CHANNEL,
  Channels.REVEAL_WINDOW_CHANNEL,
]);

export function serverUiRendererId(host: string): number | undefined {
  const match = /^server-(\d+)-[a-f0-9]{24}$/.exec(host);
  return match ? Number(match[1]) : undefined;
}

export function isBundledUiUrl(value: string): boolean {
  const url = URL.parse(value);
  return url !== null && ["t3code:", "t3code-dev:"].includes(url.protocol) && url.host === "app";
}

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
    (!isBundledUiUrl(url.href) &&
      !(serverUiRendererId(url.host) === event.sender.id && serverChannels.has(channel)))
  )
    throw new Error("Desktop IPC denied for this frame and UI origin");
}
