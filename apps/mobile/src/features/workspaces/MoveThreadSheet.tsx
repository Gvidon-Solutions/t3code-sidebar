import { Toast } from "../../components/ui/Toast";
import { machineTag } from "@t3tools/client-runtime/state/mesh-layout";
import { useEffect } from "react";
import type { ThreadMoveResult } from "@t3tools/contracts";
import { mobileMoveProjectLabel } from "./threadMove.logic";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  moveThreadWithConfirmation,
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
  const [undo, setUndo] = useState<{
    source: EnvironmentThreadShell;
    result: ThreadMoveResult;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the move undo action expires after the server's ten-second window
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 10_000);
    return () => clearTimeout(timer);
  }, [undo]);
  const close = () => {
    appAtomRegistry.set(movingThread, null);
    setQuery("");
  };
  if (!thread)
    return undo ? (
      <View className="absolute inset-x-4 bottom-8">
        <Toast
          message={`Moved to ${undo.result.machine}`}
          action={{
            label: "Undo",
            onPress: () => {
              const entry = undo;
              setUndo(null);
              void move({
                environmentId: entry.source.environmentId,
                input: {
                  threadId: entry.source.id,
                  undoHandoffId: entry.result.handoffId ?? undefined,
                },
              }).then((result) => {
                if (result._tag === "Failure")
                  Dialog.alert("Could not undo move", String(Cause.squash(result.cause)));
              });
            },
          }}
        />
      </View>
    ) : null;
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
                if (validity === "same-project") {
                  close();
                  return;
                }
                void moveThreadWithConfirmation({
                  source: thread,
                  target: project,
                  machine: machineTag(
                    config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
                    project.environmentId,
                  ),
                  confirm: (message) =>
                    new Promise<boolean>((resolve) =>
                      Dialog.confirm({
                        title: "Move conversation",
                        message,
                        confirmText: "Move",
                        onConfirm: () => resolve(true),
                        onCancel: () => resolve(false),
                      }),
                    ),
                  move,
                }).then((result) => {
                  if (result === null) return;
                  if (result._tag === "Success") {
                    if (result.value.handoffId) setUndo({ source: thread, result: result.value });
                    close();
                  } else Dialog.alert("Could not move thread", String(Cause.squash(result.cause)));
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
