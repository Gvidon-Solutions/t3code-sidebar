import { DesktopUiInfo, DesktopUiSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DesktopUi, DesktopUiError } from "../../app/DesktopUi.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { isBundledUiUrl } from "../rendererTrust.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

export const authorizeUiSender = Effect.fn("desktop.ipc.ui.authorizeSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const main = yield* (yield* ElectronWindow).main;
  if (
    !event ||
    Option.isNone(main) ||
    event.sender.id !== main.value.webContents.id ||
    !event.senderFrame ||
    event.senderFrame.parent !== null ||
    event.senderFrame.url !== main.value.webContents.getURL()
  ) {
    return yield* new DesktopUiError({
      message: "UI source changes require the main application frame",
    });
  }
});
export const select = DesktopIpc.makeIpcMethod({
  channel: Channels.UI_SELECT_CHANNEL,
  payload: DesktopUiSelection,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.ui.select")(function* (selection, event) {
    yield* authorizeUiSender(event);
    const trusted = event?.senderFrame?.url !== undefined && isBundledUiUrl(event.senderFrame.url);
    return yield* (yield* DesktopUi).select(selection, {
      trustedClient: trusted,
      ...(event?.sender.id === undefined ? {} : { rendererId: event.sender.id }),
    });
  }),
});
export const getInfo = DesktopIpc.makeIpcMethod({
  channel: Channels.UI_INFO_CHANNEL,
  payload: Schema.Void,
  result: DesktopUiInfo,
  handler: Effect.fn("desktop.ipc.ui.getInfo")(function* (_input, event) {
    yield* authorizeUiSender(event);
    return yield* (yield* DesktopUi).getInfo;
  }),
});

export const retryServerUi = DesktopIpc.makeIpcMethod({
  channel: Channels.UI_RETRY_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.ui.retryServerUi")(function* (_input, event) {
    yield* authorizeUiSender(event);
    yield* (yield* DesktopUi).retryServerUi;
  }),
});
