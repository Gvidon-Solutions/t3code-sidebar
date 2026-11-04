import { expect, it } from "vite-plus/test";
import { forkLinkMenuActions, FORK_MACHINE_MENU_ACTION } from "./threadMenuActions";

it("offers Fork to machine in the thread menu", () => {
  expect(FORK_MACHINE_MENU_ACTION).toMatchObject({
    id: "fork-machine",
    title: "Fork to machine…",
  });
});

it("lists reciprocal fork links with machine titles and exact destinations", () => {
  const origin = { environmentId: "studio", threadId: "source", title: "Notes", machine: "Studio" };
  const fork = {
    environmentId: "cloudbox",
    threadId: "copy",
    title: "Notes (fork)",
    machine: "Cloudbox",
  };
  expect(forkLinkMenuActions({ meshFork: origin, meshForks: [fork] })).toEqual([
    { id: "fork-origin", title: "Forked from Notes on Studio", target: origin },
    { id: "fork-link:0", title: "Fork: Notes (fork) on Cloudbox", target: fork },
  ]);
});
