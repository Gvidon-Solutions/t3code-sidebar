import type {
  AgentRunState,
  ThreadAgentsSummary,
} from "@t3tools/client-runtime/state/thread-agents";
import { threadAgentsLabel } from "@t3tools/client-runtime/state/thread-agents";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

const MAX_DOTS = 8;

const DOT_CLASS: Record<AgentRunState, string> = {
  working: "bg-info",
  attention: "bg-warning",
  failed: "bg-destructive",
  done: "bg-success",
};

/**
 * Sidebar fork: the subagents a thread launched, under its row — one summary
 * line ("5 agents · 4 working") with a dot per agent, and the agents' own rows
 * along a guide line while open.
 */
export function WorkspaceAgentGroup({
  summary,
  dotKeys,
  open,
  onToggle,
  children,
}: {
  summary: ThreadAgentsSummary;
  /** One stable key per agent, in `summary.states` order. */
  dotKeys: ReadonlyArray<string>;
  open: boolean;
  onToggle: () => void;
  /** The agents' rows, drawn only while open. */
  children: ReactNode;
}) {
  const label = threadAgentsLabel(summary);
  return (
    <div className="ml-3.5 flex flex-col border-l border-sidebar-border pl-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} agents: ${label}`}
        className="flex h-6 min-w-0 items-center gap-1.5 rounded-md pr-1.5 pl-1 text-left text-xs text-sidebar-muted-foreground outline-hidden transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onToggle}
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
        />
        <BotIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
          {dotKeys.slice(0, MAX_DOTS).map((dotKey, index) => (
            <span
              key={dotKey}
              className={cn("size-1.5 rounded-full", DOT_CLASS[summary.states[index] ?? "done"])}
            />
          ))}
        </span>
      </button>
      {open ? children : null}
    </div>
  );
}
