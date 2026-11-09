import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import type { EnvironmentId, FilesLocateCandidate } from "@t3tools/contracts";
import { Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useMeshLayout } from "../workspaces/useMeshLayout";
import { hideFileLocateSheet, useFileLocateSheetRequest } from "./locateFileSheetState";

export {
  showFileLocateSheet,
  type FileLocateOpenTarget,
  type FileLocateSheetRequest,
} from "./locateFileSheetState";

const basenameOf = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;

export function FileLocateSheetHost() {
  const request = useFileLocateSheetRequest();
  const { config } = useMeshLayout();
  const environments = useWorkspaceEnvironments();
  if (request === null) return null;
  const { result } = request;
  const machineOf = (environmentId: EnvironmentId) => {
    const label =
      environments.find((environment) => environment.environmentId === environmentId)
        ?.environmentLabel ?? String(environmentId);
    return machineDisplayOf(config ?? { machines: {} }, environmentId, label);
  };
  const candidates: ReadonlyArray<FilesLocateCandidate> =
    result.candidates ?? (result.target === undefined ? [] : [result.target]);
  const open = (candidate: FilesLocateCandidate) => {
    hideFileLocateSheet();
    request.openTarget({
      environmentId: candidate.environmentId,
      absolutePath: candidate.absolutePath,
      ...(candidate.line === undefined ? {} : { line: candidate.line }),
    });
  };
  return (
    <Modal transparent animationType="fade" visible onRequestClose={hideFileLocateSheet}>
      <Pressable className="flex-1 justify-center bg-black/40 px-4" onPress={hideFileLocateSheet}>
        <Pressable className="max-h-[80%] rounded-2xl bg-sheet p-4" onPress={() => undefined}>
          {result.status === "choose" ? (
            <>
              <Text className="text-lg font-t3-bold text-foreground">Which file?</Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                Several files match{" "}
                <Text className="font-mono text-foreground">{request.rawPath}</Text>.
              </Text>
              <ScrollView className="mt-3">
                {candidates.map((candidate) => {
                  const otherMachine = candidate.environmentId !== result.environmentId;
                  return (
                    <Pressable
                      key={`${candidate.environmentId}:${candidate.absolutePath}`}
                      className="rounded-lg px-2 py-2"
                      onPress={() => open(candidate)}
                    >
                      <View className="flex-row items-center gap-2">
                        <Text
                          className="flex-1 font-mono text-sm text-foreground"
                          numberOfLines={2}
                        >
                          {candidate.displayPath}
                        </Text>
                        {otherMachine || candidate.notSynced ? (
                          <Text className="rounded bg-muted px-1 text-2xs text-muted-foreground">
                            {machineOf(candidate.environmentId).tag}
                            {candidate.notSynced ? " · not synced" : ""}
                          </Text>
                        ) : null}
                      </View>
                      <Text className="text-2xs text-muted-foreground">
                        {candidate.touchedByThread ? "edited in this thread · " : ""}
                        {otherMachine ? `${machineOf(candidate.environmentId).label} · ` : ""}
                        {candidate.mtimeMs === undefined
                          ? "No modification time"
                          : new Date(candidate.mtimeMs).toLocaleString()}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </>
          ) : (
            <>
              <Text className="text-lg font-t3-bold text-foreground">File not found</Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                Couldn&apos;t find{" "}
                <Text className="font-mono text-foreground">{request.rawPath}</Text> in{" "}
                {result.projectTitle ?? machineOf(result.environmentId).label}
                {result.tried.length > 0
                  ? ` (checked ${[
                      ...new Set([
                        result.environmentId,
                        ...result.tried.flatMap((entry) =>
                          entry.environmentId === undefined ? [] : [entry.environmentId],
                        ),
                      ]),
                    ]
                      .map((environmentId) => machineOf(environmentId).tag)
                      .join(", ")})`
                  : ""}
                .
              </Text>
              <View className="mt-4 flex-row gap-2">
                <Pressable
                  className="rounded-lg bg-accent px-3 py-2"
                  onPress={() => {
                    hideFileLocateSheet();
                    request.search(basenameOf(request.rawPath));
                  }}
                >
                  <Text className="text-sm text-foreground">Search in project</Text>
                </Pressable>
                {result.cwd === undefined ? null : (
                  <Pressable
                    className="rounded-lg border border-border px-3 py-2"
                    onPress={() => {
                      hideFileLocateSheet();
                      request.openTarget({
                        environmentId: result.environmentId,
                        absolutePath: result.cwd!,
                      });
                    }}
                  >
                    <Text className="text-sm text-foreground">Open folder</Text>
                  </Pressable>
                )}
              </View>
            </>
          )}
          <Pressable className="mt-4 self-end px-2 py-1" onPress={hideFileLocateSheet}>
            <Text className="text-sm text-muted-foreground">Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
