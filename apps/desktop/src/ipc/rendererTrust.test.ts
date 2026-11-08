import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { make, type DesktopIpcSyncListener } from "./DesktopIpc.ts";
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

effectIt.effect(
  "rejects a hostile synchronous credential request without running the handler or crashing main",
  () =>
    Effect.gen(function* () {
      let listener: DesktopIpcSyncListener | undefined;
      let called = false;
      const url = "t3code://server-7/";
      const ipc = make(
        {
          removeHandler: () => undefined,
          handle: () => undefined,
          removeAllListeners: () => undefined,
          on: (_channel, callback) => {
            listener = callback;
          },
        },
        (event, channel) => authorizeDesktopIpc(event, channel, url),
      );
      yield* ipc.handleSync({
        channel: Channels.TAKE_LEGACY_LOCAL_STORAGE_CHANNEL,
        handler: () =>
          Effect.sync(() => {
            called = true;
            return { token: "private" };
          }),
      });
      const event = {
        sender: { id: 7 },
        senderFrame: { url, parent: null },
        returnValue: undefined as unknown,
      };
      expect(() => listener!(event)).not.toThrow();
      expect(event.returnValue).toBeNull();
      expect(called).toBe(false);
    }).pipe(Effect.scoped),
);
