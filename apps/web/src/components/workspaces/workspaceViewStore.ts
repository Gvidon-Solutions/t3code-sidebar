import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

/**
 * Per-device view state of the workspace sidebar. The workspace config itself
 * is a shared server setting; which workspace is open, which folders are
 * collapsed and whether the tiles show are this device's business.
 */
interface WorkspaceViewState {
  activeWorkspaceId: string | null;
  /** False: every workspace in one list, tiles hidden. */
  tilesVisible: boolean;
  /** Folder open/closed overrides by `${workspaceId}:${projectKey}`; absent = default. */
  folderOpen: Record<string, boolean>;
  /** Sections such as quiet projects and snoozed, by key. */
  sectionOpen: Record<string, boolean>;
  /** Folders showing their full thread list instead of the preview. */
  folderExpanded: Record<string, boolean>;
  /** Folders showing their settled tail. */
  settledOpen: Record<string, boolean>;
  /**
   * When this device started using the workspace sidebar. A completion after
   * it reads as Done even for a thread this device never opened; older history
   * stays quiet instead of flooding a fresh browser with Done badges.
   */
  seenBaselineAt: string | null;
  /** Last open thread per workspace, to return to it when switching back. */
  lastThreadByWorkspace: Record<string, string>;
  setActiveWorkspace: (workspaceId: string | null) => void;
  toggleTiles: () => void;
  setFolderOpen: (key: string, open: boolean) => void;
  setSectionOpen: (key: string, open: boolean) => void;
  toggleFolderExpanded: (key: string) => void;
  toggleSettledOpen: (key: string) => void;
  rememberThread: (workspaceId: string, threadKey: string) => void;
  ensureSeenBaseline: () => void;
}

export const useWorkspaceViewStore = create<WorkspaceViewState>()(
  persist(
    (set) => ({
      activeWorkspaceId: null,
      tilesVisible: true,
      folderOpen: {},
      sectionOpen: {},
      folderExpanded: {},
      settledOpen: {},
      lastThreadByWorkspace: {},
      seenBaselineAt: null,
      setActiveWorkspace: (activeWorkspaceId) => set({ activeWorkspaceId }),
      toggleTiles: () => set((state) => ({ tilesVisible: !state.tilesVisible })),
      setFolderOpen: (key, open) =>
        set((state) => ({ folderOpen: { ...state.folderOpen, [key]: open } })),
      setSectionOpen: (key, open) =>
        set((state) => ({ sectionOpen: { ...state.sectionOpen, [key]: open } })),
      toggleFolderExpanded: (key) =>
        set((state) => ({
          folderExpanded: { ...state.folderExpanded, [key]: !state.folderExpanded[key] },
        })),
      toggleSettledOpen: (key) =>
        set((state) => ({ settledOpen: { ...state.settledOpen, [key]: !state.settledOpen[key] } })),
      rememberThread: (workspaceId, threadKey) =>
        set((state) =>
          state.lastThreadByWorkspace[workspaceId] === threadKey
            ? state
            : {
                lastThreadByWorkspace: { ...state.lastThreadByWorkspace, [workspaceId]: threadKey },
              },
        ),
      ensureSeenBaseline: () =>
        set((state) =>
          state.seenBaselineAt !== null ? state : { seenBaselineAt: new Date().toISOString() },
        ),
    }),
    {
      name: "t3code:workspace-sidebar:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        activeWorkspaceId: state.activeWorkspaceId,
        tilesVisible: state.tilesVisible,
        folderOpen: state.folderOpen,
        sectionOpen: state.sectionOpen,
        folderExpanded: state.folderExpanded,
        settledOpen: state.settledOpen,
        lastThreadByWorkspace: state.lastThreadByWorkspace,
        seenBaselineAt: state.seenBaselineAt,
      }),
    },
  ),
);
