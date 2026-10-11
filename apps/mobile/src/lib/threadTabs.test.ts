import { describe, expect, it } from "vite-plus/test";

import {
  THREAD_TABS_MAX,
  closeThreadTab,
  openThreadTab,
  sanitizeThreadTabs,
  updateThreadTab,
  withThreadTabs,
} from "./threadTabs";

describe("thread tabs", () => {
  it("reopening a tab keeps its place and position", () => {
    let state = openThreadTab(undefined, "a.md", 1);
    state = updateThreadTab(state, "a.md", { scroll: { mode: "preview", y: 420 } }, 2);
    state = openThreadTab(state, "b.pdf", 3);
    state = openThreadTab(state, "a.md", 4);
    expect(state.tabs.map((tab) => tab.path)).toEqual(["a.md", "b.pdf"]);
    expect(state.tabs[0]?.scroll?.preview).toBe(420);
  });

  it("closes the least recently used tab past the limit", () => {
    let state = openThreadTab(undefined, "keep.md", 100);
    for (let index = 0; index < THREAD_TABS_MAX; index += 1) {
      state = openThreadTab(state, `f${index}.md`, index);
    }
    expect(state.tabs).toHaveLength(THREAD_TABS_MAX);
    expect(state.tabs.map((tab) => tab.path)).toContain("keep.md");
    expect(state.tabs.map((tab) => tab.path)).not.toContain("f0.md");
  });

  it("drops threads with no tabs and survives a corrupt blob", () => {
    const one = withThreadTabs(undefined, "env:t1", openThreadTab(undefined, "a.md", 1));
    const both = withThreadTabs(one, "env:t2", closeThreadTab(undefined, "x", 2));
    expect(Object.keys(both)).toEqual(["env:t1"]);
    expect(
      sanitizeThreadTabs({
        "env:t1": { usedAt: 1, tabs: [{ path: 3 }, { path: "a", usedAt: 1, mode: "nope" }] },
      }),
    ).toEqual({ "env:t1": { usedAt: 1, tabs: [{ path: "a", usedAt: 1, scroll: {} }] } });
  });
});
