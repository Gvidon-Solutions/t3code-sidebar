import { Atom } from "effect/reactivity";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { appAtomRegistry } from "../../rpc/atomRegistry";

export interface ForkThreadRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export const forkingThread = Atom.make<ForkThreadRequest | null>(null);

export function openForkThread(request: ForkThreadRequest) {
  appAtomRegistry.set(forkingThread, request);
}

export function closeForkThread() {
  appAtomRegistry.set(forkingThread, null);
}
