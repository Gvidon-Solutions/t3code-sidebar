import { Atom } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { appAtomRegistry } from "../../state/atom-registry";

export const forkingThread = Atom.make<EnvironmentThreadShell | null>(null);

export function openForkThreadSheet(thread: EnvironmentThreadShell) {
  appAtomRegistry.set(forkingThread, thread);
}
