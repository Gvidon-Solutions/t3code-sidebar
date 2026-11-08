import { useNavigate } from "@tanstack/react-router";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** One prepared request the owner can hand to an agent, with a copy fallback. */
export function AgentFixActions({
  prompt,
  label = "Fix with an agent",
}: {
  readonly prompt: string;
  readonly label?: string;
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
        onClick={() => void navigate({ to: "/new", search: { prompt } as never })}
      >
        {label}
      </Button>
      <Button size="xs" variant="ghost" onClick={() => void copy()}>
        Copy prompt
      </Button>
    </span>
  );
}
