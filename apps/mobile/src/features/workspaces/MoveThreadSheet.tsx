import { mobileMoveProjectLabel } from "./threadMove.logic";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Pressable, ScrollView, TextInput } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  CROSS_MACHINE_MOVE_MESSAGE,
  threadMoveValidity,
} from "@t3tools/client-runtime/state/mesh-layout";
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

const movingThread = Atom.make<EnvironmentThreadShell | null>(null);
export function openMoveThreadSheet(thread: EnvironmentThreadShell) {
  appAtomRegistry.set(movingThread, thread);
}
export function MoveThreadSheet() {
  const thread = useAtomValue(movingThread);
  const projects = useProjects();
  const { config } = useSidebarWorkspaces();
  const move = useAtomCommand(threadEnvironment.move, { reportFailure: false });
  const [query, setQuery] = useState("");
  const close = () => {
    appAtomRegistry.set(movingThread, null);
    setQuery("");
  };
  if (!thread) return null;
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
                const validity = threadMoveValidity(thread, project);
                if (validity === "cross-machine") {
                  Dialog.alert("Could not move thread", CROSS_MACHINE_MOVE_MESSAGE);
                  return;
                }
                if (validity === "same-project") {
                  close();
                  return;
                }
                void move({
                  environmentId: thread.environmentId,
                  input: { threadId: thread.id, projectId: project.id },
                }).then((result) => {
                  if (result._tag === "Success") close();
                  else Dialog.alert("Could not move thread", String(Cause.squash(result.cause)));
                });
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
