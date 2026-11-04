import type { MenuAction } from "@react-native-menu/menu";

export const FORK_MACHINE_MENU_ACTION: MenuAction = {
  id: "fork-machine",
  title: "Fork to machine…",
  image: "arrow.triangle.branch",
};

export function forkLinkMenuActions(thread: {
  readonly meshFork?: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly title: string;
    readonly machine: string;
  };
  readonly meshForks?: ReadonlyArray<{
    readonly environmentId: string;
    readonly threadId: string;
    readonly title: string;
    readonly machine: string;
  }>;
}) {
  return [
    ...(thread.meshFork
      ? [
          {
            id: "fork-origin",
            title: `Forked from ${thread.meshFork.title} on ${thread.meshFork.machine}`,
            target: thread.meshFork,
          },
        ]
      : []),
    ...(thread.meshForks ?? []).map((fork, index) => ({
      id: `fork-link:${index}`,
      title: `Fork: ${fork.title} on ${fork.machine}`,
      target: fork,
    })),
  ];
}
