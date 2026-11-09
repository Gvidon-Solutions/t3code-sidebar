import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

/** One prepared request the owner can hand to an agent, with a copy fallback. */
export function AgentFixActions({
  prompt,
  label = "Fix with an agent",
  accessibleLabel,
  environmentId,
}: {
  readonly prompt: string;
  readonly label?: string;
  /** Names the machine or problem so repeated rows are distinct to a screen reader. */
  readonly accessibleLabel?: string;
  /** The machine that must open the prepared thread, when the view knows it. */
  readonly environmentId?: string | null;
}) {
  const navigate = useNavigate();
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toastManager.add({ type: "success", title: "Prompt copied" });
    } catch {
      // The clipboard can be blocked (permissions, a non-secure origin); keep the
      // prompt reachable and selected so it can still be copied by hand.
      setManualCopy(prompt);
    }
  };
  return (
    <>
      <span className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          aria-label={accessibleLabel ?? label}
          onClick={() =>
            void navigate({
              to: "/new",
              search: (environmentId ? { prompt, env: environmentId } : { prompt }) as never,
            })
          }
        >
          {label}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void copy()}>
          Copy prompt
        </Button>
      </span>
      <Dialog open={manualCopy !== null} onOpenChange={(open) => !open && setManualCopy(null)}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Copy the prompt by hand</DialogTitle>
            <DialogDescription>
              The clipboard is unavailable. The text below is selected; copy it from here.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <textarea
              aria-label="Prompt to copy"
              autoFocus
              className="min-h-40 w-full resize-y rounded border border-border bg-background p-2 font-mono text-xs"
              readOnly
              value={manualCopy ?? ""}
              onFocus={(event) => event.currentTarget.select()}
            />
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => setManualCopy(null)}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
