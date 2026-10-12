import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "../../state/threads";

let previous: ReadonlyArray<EnvironmentThreadShell> = [];

/**
 * Unarchived subagent threads (sidebar fork). Home's navigation list leaves
 * them out; workspace Home hangs them under the thread that started them.
 * Keeps its identity while no subagent changed.
 */
export const agentThreadShellsAtom = Atom.make((get) => {
  const next = get(environmentThreadShells.threadShellsAtom).filter(
    (thread) => thread.archivedAt === null && thread.lineage.relationshipToParent === "subagent",
  );
  if (next.length === previous.length && next.every((thread, index) => thread === previous[index]))
    return previous;
  previous = next;
  return next;
}).pipe(Atom.withLabel("workspace-agent-thread-shells"));
