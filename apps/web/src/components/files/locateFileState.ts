import type { EnvironmentId, FilesLocateResult } from "@t3tools/contracts";
import { create } from "zustand";

export interface FileLocateOpenTarget {
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string;
  readonly line?: number;
  readonly root?: string;
}

export interface FileLocateDialogRequest {
  readonly rawPath: string;
  readonly result: FilesLocateResult;
  readonly openTarget: (target: FileLocateOpenTarget) => void;
  readonly search: (term: string) => void;
}

interface FileLocateDialogState {
  request: FileLocateDialogRequest | null;
  show: (request: FileLocateDialogRequest) => void;
  close: () => void;
}

export const useFileLocateDialogStore = create<FileLocateDialogState>((set) => ({
  request: null,
  show: (request) => set({ request }),
  close: () => set({ request: null }),
}));
