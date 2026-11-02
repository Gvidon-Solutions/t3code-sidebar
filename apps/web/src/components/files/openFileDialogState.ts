import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

interface OpenFileDialogState {
  isOpen: boolean;
  /** The machine picked when the command was opened, if known. */
  initialEnvironmentId: EnvironmentId | null;
  open: (environmentId?: EnvironmentId) => void;
  close: () => void;
}

export const useOpenFileDialogStore = create<OpenFileDialogState>((set) => ({
  isOpen: false,
  initialEnvironmentId: null,
  open: (environmentId) => set({ isOpen: true, initialEnvironmentId: environmentId ?? null }),
  close: () => set({ isOpen: false }),
}));

export function openOpenFileDialog(environmentId?: EnvironmentId) {
  useOpenFileDialogStore.getState().open(environmentId);
}
