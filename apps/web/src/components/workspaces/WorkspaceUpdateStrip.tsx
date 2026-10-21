import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DownloadIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
} from "../desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { describeDesktopUpdateProgress } from "./desktopUpdateProgress";

/**
 * Sidebar fork: this app's update while it runs in the background — the
 * download's percent, then "Restart to update", or why it failed. Sits above
 * the workspace tiles; shows nothing when no update is in flight.
 */
export function WorkspaceUpdateStrip() {
  const state = useDesktopUpdateState();
  const [pending, setPending] = useState(false);
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const progress = describeDesktopUpdateProgress(state);
  if (!bridge || !state || !progress) return null;

  const retriesDownload = progress.kind === "failed" && state.errorContext === "download";
  const act = async () => {
    if (pending || progress.kind === "downloading") return;
    setPending(true);
    // settlePromise instead of try/catch/finally, which the React Compiler can't compile.
    const outcome = await settlePromise(async () => {
      if (retriesDownload) {
        await bridge.downloadUpdate();
        return;
      }
      const confirmed = await ensureLocalApi().dialogs.confirm(
        getDesktopUpdateInstallConfirmationMessage(state),
      );
      if (!confirmed) return;
      const result = await bridge.installUpdate();
      const error = getDesktopUpdateActionError(result);
      if (error) throw new Error(error);
    });
    if (outcome._tag === "Failure") {
      const error = squashAtomCommandFailure(outcome);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: retriesDownload ? "Could not download update" : "Could not install update",
          description: error instanceof Error ? error.message : "Something went wrong.",
        }),
      );
    }
    setPending(false);
  };

  const Icon =
    progress.kind === "downloading"
      ? DownloadIcon
      : progress.kind === "failed"
        ? TriangleAlertIcon
        : RotateCwIcon;
  const label = pending && !retriesDownload ? "Installing…" : progress.label;

  return (
    <div className="shrink-0 border-t border-sidebar-border/60 px-2 pt-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={progress.detail}
              aria-disabled={progress.kind === "downloading" || pending || undefined}
              className={cn(
                "flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left text-xs outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                progress.kind === "downloading"
                  ? "cursor-default text-sidebar-muted-foreground"
                  : "text-sidebar-foreground transition-colors hover:bg-sidebar-row-hover",
              )}
              onClick={() => void act()}
            />
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon
              className={cn("size-3.5 shrink-0", progress.kind === "failed" && "text-destructive")}
            />
            <span className="truncate">{label}</span>
          </span>
          {progress.kind === "downloading" ? (
            <span className="h-0.5 w-full overflow-hidden rounded-full bg-sidebar-border">
              <span
                className="block h-full rounded-full bg-sidebar-foreground/60"
                style={{ width: `${progress.percent ?? 0}%` }}
              />
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-80 whitespace-normal">
          {progress.detail}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
