import type { EnvironmentId, FilesLocateResult } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

export interface FileLocateOpenTarget {
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string;
  readonly line?: number;
  readonly root?: string;
}

export interface FileLocateSheetRequest {
  readonly rawPath: string;
  readonly result: FilesLocateResult;
  readonly openTarget: (target: FileLocateOpenTarget) => void;
  readonly search: (term: string) => void;
}

let current: FileLocateSheetRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function showFileLocateSheet(request: FileLocateSheetRequest): void {
  current = request;
  emit();
}

export function hideFileLocateSheet(): void {
  current = null;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useFileLocateSheetRequest(): FileLocateSheetRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}
