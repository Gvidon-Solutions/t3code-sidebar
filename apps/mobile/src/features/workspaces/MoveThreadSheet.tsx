import { MoveThreadTargetModel } from "./MoveThreadTargetModel";
import { Toast } from "../../components/ui/Toast";
import { machineTag } from "@t3tools/client-runtime/state/mesh-layout";
import { useEffect } from "react";
import type { ThreadMoveResult } from "@t3tools/contracts";
import { mobileMoveProjectLabel } from "./threadMove.logic";
import { useAtomValue } from "@effect/atom-react";
import { movingThread } from "./moveThreadState";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  localThreadMoveTarget,
  moveThreadWithConfirmation,
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

export function MoveThreadSheet() {
  const thread = useAtomValue(movingThread);
  const projects = useProjects();
  const { config } = useSidebarWorkspaces();
  const move = useAtomCommand(threadEnvironment.move, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<(typeof projects)[number] | null>(null);
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
    setTarget(null);
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
  if (target)
    return (
      <MoveThreadTargetModel
        target={target}
        current={thread.modelSelection}
        runtimeMode={thread.runtimeMode}
        machine={machineTag(config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG, target.environmentId)}
        crossMachine={thread.environmentId !== target.environmentId}
        copyHere={
          thread.environmentId !== target.environmentId
            ? {
                label: `Create a copy of ${target.title} on ${machineTag(config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG, thread.environmentId)} and move here`,
                run: async () => {
                  const result = await move({
                    environmentId: thread.environmentId,
                    input: {
                      threadId: thread.id,
                      projectId: target.id,
                      targetEnvironmentId: target.environmentId,
                      createCopy: true,
                    },
                  });
                  if (result._tag === "Success") close();
                  else Dialog.alert("Could not move thread", String(Cause.squash(result.cause)));
                },
              }
            : undefined
        }
        onClose={() => setTarget(null)}
        onMove={(modelSelection) => {
          void moveThreadWithConfirmation({
            source: thread,
            target,
            modelSelection,
            machine: machineTag(config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG, target.environmentId),
            confirm: async () => true,
            move,
          }).then((result) => {
            if (result === null) return;
            if (result._tag === "Success") {
              if (result.value.handoffId) setUndo({ source: thread, result: result.value });
              close();
            } else Dialog.alert("Could not move thread", String(Cause.squash(result.cause)));
          });
        }}
      />
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
          .filter((project) =>
            mobileMoveProjectLabel(project, config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG)
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((project) => (
            <Pressable
              key={`${project.environmentId}:${project.id}`}
              className="p-4"
              onPress={() =>
                setTarget(
                  localThreadMoveTarget(
                    config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
                    thread.environmentId,
                    project,
                    projects,
                  ),
                )
              }
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
