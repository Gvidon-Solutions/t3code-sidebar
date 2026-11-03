import { Atom } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { appAtomRegistry } from "../../state/atom-registry";
export const movingThread = Atom.make<EnvironmentThreadShell | null>(null);
export function openMoveThreadSheet(thread: EnvironmentThreadShell) {
  appAtomRegistry.set(movingThread, thread);
}
