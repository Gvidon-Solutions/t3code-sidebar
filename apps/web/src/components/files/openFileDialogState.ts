import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

interface OpenFileDialogState {
  isOpen: boolean;
  initialPath: string | null;
  /** The machine picked when the command was opened, if known. */
  initialEnvironmentId: EnvironmentId | null;
  open: (environmentId?: EnvironmentId, path?: string) => void;
  close: () => void;
}

export const useOpenFileDialogStore = create<OpenFileDialogState>((set) => ({
  isOpen: false,
  initialPath: null,
  initialEnvironmentId: null,
  open: (environmentId, path) =>
    set({ isOpen: true, initialEnvironmentId: environmentId ?? null, initialPath: path ?? null }),
  close: () => set({ isOpen: false }),
}));

export function openOpenFileDialog(environmentId?: EnvironmentId, path?: string) {
  useOpenFileDialogStore.getState().open(environmentId, path);
}
