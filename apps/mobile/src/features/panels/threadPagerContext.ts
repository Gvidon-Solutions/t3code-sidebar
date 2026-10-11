import { createContext, useContext } from "react";

/** Whether a page's content lets a horizontal swipe flip to the previous / next page. */
export interface PageEdges {
  readonly prev: boolean;
  readonly next: boolean;
}

export interface ThreadPagerControls {
  /** Shows a file tab, opening it first if needed; null shows the chat. */
  readonly goTo: (path: string | null, line?: string | null) => void;
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
