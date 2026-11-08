import { useNavigate } from "@tanstack/react-router";
import { Button } from "../ui/button";
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
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toastManager.add({ type: "success", title: "Prompt copied" });
    } catch {
      toastManager.add({ type: "error", title: "Could not copy the prompt" });
    }
  };
  return (
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
  );
}
