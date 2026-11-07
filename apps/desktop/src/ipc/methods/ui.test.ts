import type * as Electron from "electron";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { authorizeUiSender } from "./ui.ts";

it.effect("permits only the current main application frame to select or inspect desktop UI", () =>
  Effect.gen(function* () {
    const main = {
      webContents: { id: 23, getURL: () => "t3code://app/threads/studio" },
    } as Electron.BrowserWindow;
    const valid = {
      sender: { id: 23 },
      senderFrame: { url: main.webContents.getURL(), parent: null },
    };
    yield* authorizeUiSender(valid);
    for (const request of [
      undefined,
      { ...valid, sender: { id: 24 } },
      { ...valid, senderFrame: { ...valid.senderFrame, parent: {} } },
      { ...valid, senderFrame: { ...valid.senderFrame, url: "https://intruder.example" } },
      { ...valid, senderFrame: null },
    ]) {
      expect((yield* authorizeUiSender(request).pipe(Effect.result))._tag).toBe("Failure");
    }
  }).pipe(
    Effect.provideService(ElectronWindow, {
      main: Effect.succeedSome({
        webContents: { id: 23, getURL: () => "t3code://app/threads/studio" },
      } as Electron.BrowserWindow),
    } as ElectronWindow["Service"]),
  ),
);
