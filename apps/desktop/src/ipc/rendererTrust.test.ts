import { expect, it } from "vite-plus/test";
import { authorizeDesktopIpc } from "./rendererTrust.ts";
import * as Channels from "./channels.ts";

it("denies every privileged IPC channel to server UI, foreign origins and subframes", () => {
  const event = (url: string, parent: unknown | null = null) => ({
    sender: { id: 7 },
    senderFrame: { url, parent },
  });
  const server = "t3code://server-7/";
  for (const channel of [
    Channels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL,
    Channels.GET_CONNECTION_CATALOG_CHANNEL,
    Channels.SET_CONNECTION_CATALOG_CHANNEL,
    Channels.ENSURE_SSH_ENVIRONMENT_CHANNEL,
    Channels.SET_SERVER_EXPOSURE_MODE_CHANNEL,
    Channels.READ_MEDIA_CHANNEL,
    Channels.OPEN_EXTERNAL_CHANNEL,
    Channels.TAKE_LEGACY_LOCAL_STORAGE_CHANNEL,
  ]) {
    expect(() => authorizeDesktopIpc(event(server), channel, server)).toThrow(/denied/);
    const app = "t3code://app/";
    expect(() => authorizeDesktopIpc(event(app), channel, app)).not.toThrow();
    expect(() => authorizeDesktopIpc(event(app, {}), channel, app)).toThrow();
    expect(() =>
      authorizeDesktopIpc(event("https://attacker.example"), channel, "https://attacker.example"),
    ).toThrow();
    expect(() => authorizeDesktopIpc(event(app), channel, server)).toThrow();
  }
  expect(() => authorizeDesktopIpc(event(server), Channels.UI_INFO_CHANNEL, server)).not.toThrow();
  expect(() =>
    authorizeDesktopIpc(
      event("t3code://server-9/"),
      Channels.UI_INFO_CHANNEL,
      "t3code://server-9/",
    ),
  ).toThrow();
});
