import { describe, expect, it, vi } from "vite-plus/test";
import { afterChatSendsSettled, draftSendState } from "./draftSendState";

describe("chat send reload barrier", () => {
  it("retains the pending send across remounts and waits for dispatch on every route", async () => {
    const studio = draftSendState("studio/send-retry").sendInFlight;
    const cloudbox = draftSendState("cloudbox/send-retry").sendInFlight;
    let accept = () => {};
    const acceptance = new Promise<void>((resolve) => {
      accept = resolve;
    });
    studio.current = true;
    cloudbox.current = true;
    const dispatch = acceptance.finally(() => {
      draftSendState("studio/send-retry").sendInFlight.current = false;
    });
    const reload = vi.fn();
    const cancel = afterChatSendsSettled(reload);
    try {
      expect(draftSendState("studio/send-retry").sendInFlight.current).toBe(true);
      expect(reload).not.toHaveBeenCalled();
      cloudbox.current = false;
      expect(reload).not.toHaveBeenCalled();
      accept();
      await dispatch;
      expect(reload).toHaveBeenCalledOnce();
      studio.current = false;
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      cancel();
      accept();
      studio.current = false;
      cloudbox.current = false;
      await dispatch;
    }
  });

  it("cancels a superseded source reload and reloads immediately after all sends settled", () => {
    const sending = draftSendState("studio/source-switch").sendInFlight;
    sending.current = true;
    const staleReload = vi.fn();
    const cancel = afterChatSendsSettled(staleReload);
    cancel();
    sending.current = false;
    expect(staleReload).not.toHaveBeenCalled();
    const currentReload = vi.fn();
    afterChatSendsSettled(currentReload)();
    expect(currentReload).toHaveBeenCalledOnce();
  });
});
