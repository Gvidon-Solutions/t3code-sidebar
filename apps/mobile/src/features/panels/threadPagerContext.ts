import { createContext, useContext } from "react";

/** Whether a page's content lets a horizontal swipe flip to the previous / next page. */
export interface PageEdges {
  readonly prev: boolean;
  readonly next: boolean;
}

/** A shell of this thread shown as a pager tab. */
export interface ThreadPagerTerminal {
  readonly terminalId: string;
  readonly label: string;
}

export interface ThreadPagerControls {
  /**
   * Shows a file tab, opening it first if needed, or a terminal tab
   * (`terminalTabKey`), starting its shell if needed; null shows the chat.
   */
  readonly goTo: (path: string | null, line?: string | null) => void;
  /** The thread's terminal tabs, in strip order. */
  readonly terminals: ReadonlyArray<ThreadPagerTerminal>;
  /** Kills a terminal's shell and drops its tab. */
  readonly closeTerminal: (terminalId: string) => void;
  /** Drops the tab of a shell that already exited. */
  readonly forgetTerminal: (terminalId: string) => void;
}

/** The thread pager around the chat and its file tabs (sidebar fork); null outside it. */
export const ThreadPagerContext = createContext<ThreadPagerControls | null>(null);

export const useThreadPager = () => useContext(ThreadPagerContext);

/**
 * Lets a page's content hold the swipe for itself, as a zoomed PDF does until
 * it is panned to its edge. Null outside the pager.
 */
export const ThreadPageEdgesContext = createContext<((edges: PageEdges) => void) | null>(null);

export const useReportPageEdges = () => useContext(ThreadPageEdgesContext);
