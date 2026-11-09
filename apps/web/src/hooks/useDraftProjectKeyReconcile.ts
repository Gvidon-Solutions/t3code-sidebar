import { useEffect } from "react";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useMeshLayout } from "./useMeshLayout";
import { useProjects } from "../state/entities";
import { useClientSettings } from "./useSettings";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { planDraftLogicalProjectKeyRekeys } from "../state/draftProjectKey";

/**
 * Moves drafts made before the mesh snapshot loaded from the grouping key to the
 * mesh logical key. Without this, the next "new thread" opens a second draft.
 */
export function useDraftProjectKeyReconcile() {
  const mesh = useMeshLayout();
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const rekeyLogicalProjectDraft = useComposerDraftStore((store) => store.rekeyLogicalProjectDraft);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves persisted drafts to the mesh logical key once the replicated layout arrives
  useEffect(() => {
    const rekeys = planDraftLogicalProjectKeyRekeys({
      drafts: Object.entries(draftThreadsByThreadKey).map(([draftId, draft]) => ({
        draftId,
        environmentId: String(draft.environmentId),
        projectId: String(draft.projectId),
        logicalProjectKey: draft.logicalProjectKey,
      })),
      projects,
      config: mesh.config,
      groupingSettings,
    });
    for (const rekey of rekeys)
      rekeyLogicalProjectDraft(DraftId.make(rekey.draftId), rekey.logicalProjectKey);
  }, [draftThreadsByThreadKey, mesh.config, projects, groupingSettings, rekeyLogicalProjectDraft]);
  return null;
}
