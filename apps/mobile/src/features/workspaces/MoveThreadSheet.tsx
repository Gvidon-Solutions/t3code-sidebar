import { mobileMoveProjectLabel } from "./threadMove.logic";
import { useAtomValue } from "@effect/atom-react";
import { movingThread } from "./moveThreadState";
import { useState } from "react";
import { Pressable, ScrollView, TextInput } from "react-native";
import { localThreadMoveTarget, moveThread } from "@t3tools/client-runtime/state/mesh-layout";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { Sheet } from "../../components/ui/Sheet";
import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSidebarWorkspaces } from "./useSidebarWorkspaces";
import * as Cause from "effect/Cause";

export function MoveThreadSheet() {
  const thread = useAtomValue(movingThread);
  const projects = useProjects();
  const { config } = useSidebarWorkspaces();
  const move = useAtomCommand(threadEnvironment.move, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<(typeof projects)[number] | null>(null);
  const close = () => {
    appAtomRegistry.set(movingThread, null);
    setQuery("");
    setTarget(null);
  };
  if (!thread) return null;
  if (target)
    return (
      <Sheet
        title={`Move to ${target.isScratch ? "No project" : target.title}?`}
        onClose={() => setTarget(null)}
      >
        <AppText className="p-4 text-muted-foreground">
          {config?.machines[target.environmentId]?.title ??
            config?.machines[target.environmentId]?.label ??
            "This machine"}
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Confirm move"
          className="p-4"
          onPress={() => {
            void moveThread({
              source: thread,
              target,
              move,
            }).then((result) => {
              if (result === null) return;
              if (result._tag === "Success") close();
              else Dialog.alert("Could not move thread", String(Cause.squash(result.cause)));
            });
          }}
        >
          <AppText>Move to {target.isScratch ? "No project" : target.title}</AppText>
        </Pressable>
        <Pressable accessibilityRole="button" className="p-4" onPress={() => setTarget(null)}>
          <AppText>Cancel</AppText>
        </Pressable>
      </Sheet>
    );
  return (
    <Sheet title="Move to project…" onClose={close}>
      <TextInput
        accessibilityLabel="Search projects"
        value={query}
        onChangeText={setQuery}
        className="m-4 rounded border border-border p-3 text-foreground"
      />
      <ScrollView>
        {projects
          .filter((project) => project.environmentId === thread.environmentId)
          .filter((project) =>
            mobileMoveProjectLabel(project, config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG)
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((project) => (
            <Pressable
              key={`${project.environmentId}:${project.id}`}
              className="p-4"
              onPress={() => {
                const resolved = localThreadMoveTarget(
                  config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
                  thread.environmentId,
                  project,
                  projects,
                );
                if (resolved.environmentId !== thread.environmentId) return;
                setTarget(resolved);
              }}
            >
              <AppText>
                {mobileMoveProjectLabel(project, config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG)}
              </AppText>
            </Pressable>
          ))}
      </ScrollView>
    </Sheet>
  );
}
