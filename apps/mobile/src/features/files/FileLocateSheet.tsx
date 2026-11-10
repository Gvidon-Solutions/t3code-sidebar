import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import type { EnvironmentId, FilesLocateCandidate } from "@t3tools/contracts";
import { Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { relativeTime } from "../../lib/time";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { MachineTag } from "../workspaces/MachineTag";
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
  const mixedMachines = new Set(candidates.map((candidate) => candidate.environmentId)).size > 1;
  const cwd = result.cwd;
  const open = (candidate: FilesLocateCandidate) => {
    hideFileLocateSheet();
    request.openTarget({
      environmentId: candidate.environmentId,
      absolutePath: candidate.absolutePath,
      ...(candidate.line === undefined ? {} : { line: candidate.line }),
      ...(candidate.root === undefined ? {} : { root: candidate.root }),
      rawPath: request.rawPath,
      displayPath: candidate.displayPath,
      ...(result.projectTitle === undefined ? {} : { projectTitle: result.projectTitle }),
      inProject: candidate.inProject,
      ...(candidate.notSynced ? { notSynced: true } : {}),
    });
  };
  const checkedMachines = [
    ...new Set([
      result.environmentId,
      ...result.tried.flatMap((entry) =>
        entry.environmentId === undefined ? [] : [entry.environmentId],
      ),
    ]),
  ]
    .map((environmentId) => machineOf(environmentId).tag)
    .join(", ");
  return (
    <Modal transparent animationType="fade" visible onRequestClose={hideFileLocateSheet}>
      <Pressable className="flex-1 justify-center bg-black/60 px-4" onPress={hideFileLocateSheet}>
        <Pressable
          className="max-h-[80%] rounded-2xl border border-border bg-sheet-solid p-4"
          onPress={() => undefined}
        >
          {result.status === "choose" ? (
            <>
              <Text className="text-lg font-t3-bold text-foreground">Which file?</Text>
              <Text className="mt-1 text-sm text-foreground-muted">Several files match</Text>
              <Text className="mt-1 font-mono text-sm text-foreground" selectable>
                {request.rawPath}
              </Text>
              <ScrollView className="mt-3">
                {candidates.map((candidate, index) => {
                  const otherMachine = candidate.environmentId !== result.environmentId;
                  const best = index === 0;
                  return (
                    <Pressable
                      key={`${candidate.environmentId}:${candidate.absolutePath}`}
                      accessibilityState={{ selected: best }}
                      className={`mb-1 rounded-xl border px-3 py-2 ${
                        best ? "border-ring bg-accent" : "border-border"
                      }`}
                      onPress={() => open(candidate)}
                    >
                      <View className="flex-row items-center gap-2">
                        <Text
                          className="flex-1 font-mono text-sm text-foreground"
                          numberOfLines={2}
                        >
                          {candidate.displayPath}
                        </Text>
                        {best ? (
                          <Text className="rounded bg-primary px-1 py-0.5 text-2xs text-primary-foreground">
                            Best match
                          </Text>
                        ) : null}
                      </View>
                      <View className="mt-1 flex-row flex-wrap items-center gap-2">
                        {mixedMachines || otherMachine || candidate.notSynced ? (
                          <MachineTag machine={machineOf(candidate.environmentId)} />
                        ) : null}
                        {candidate.touchedByThread ? (
                          <Text className="text-2xs text-foreground">edited in this thread</Text>
                        ) : null}
                        <Text className="text-2xs text-foreground-muted">
                          {candidate.mtimeMs === undefined
                            ? "No modification time"
                            : relativeTime(new Date(candidate.mtimeMs).toISOString())}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </>
          ) : (
            <>
              <Text className="text-lg font-t3-bold text-foreground">File not found</Text>
              <Text className="mt-1 text-sm text-foreground-muted">Couldn&apos;t find</Text>
              <Text className="mt-1 font-mono text-sm text-foreground" selectable>
                {request.rawPath}
              </Text>
              <Text className="mt-1 text-sm text-foreground-muted">
                in {result.projectTitle ?? machineOf(result.environmentId).label}
                {result.tried.length > 0 ? ` (checked ${checkedMachines})` : ""}.
              </Text>
              <View className="mt-4 flex-row flex-wrap gap-2">
                <Pressable
                  className="rounded-lg bg-primary px-3 py-2"
                  onPress={() => {
                    hideFileLocateSheet();
                    request.search(basenameOf(request.rawPath));
                  }}
                >
                  <Text className="text-sm text-primary-foreground">Search in project</Text>
                </Pressable>
                {cwd === undefined ? null : (
                  <Pressable
                    className="rounded-lg border border-border px-3 py-2"
                    onPress={() => {
                      if (cwd === undefined) return;
                      hideFileLocateSheet();
                      request.openTarget({
                        environmentId: result.environmentId,
                        absolutePath: cwd,
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
            <Text className="text-sm text-foreground">Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
