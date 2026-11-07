import { type DesktopUiInfo } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { afterChatSendsSettled } from "../chat/draftSendState";
import { DraftId, flushComposerDrafts, useComposerDraftStore } from "../../composerDraftStore";
import {
  useEnvironments,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "../../state/environments";

export function DesktopUiCoordinator() {
  const ui = window.desktopBridge?.ui;
  const [loaded, setLoaded] = useState<DesktopUiInfo | null>(null);
  const routeEnvironment = useParams({ strict: false, select: (params) => params.environmentId });
  const draftId = useParams({ strict: false, select: (params) => params.draftId });
  const draftEnvironment = useComposerDraftStore((state) =>
    draftId ? state.getDraftSession(DraftId.make(draftId))?.environmentId : undefined,
  );
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [remembered, setRemembered] = useState<string | null>(null);
  const requested = routeEnvironment ?? draftEnvironment;
  if (requested && requested !== remembered) setRemembered(requested);
  const selectedId =
    requested ??
    remembered ??
    loaded?.environmentId ??
    primary ??
    environments.find((entry) => entry.connection.phase === "connected")?.environmentId;
  const environment = environments.find((entry) => entry.environmentId === selectedId);
  const environmentId = environment?.environmentId ?? null;
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const version =
    environment?.connection.phase === "connected"
      ? environment.serverConfig?.environment.serverVersion
      : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the shell's current UI source across the IPC boundary before choosing the startup environment
  useEffect(() => {
    if (!ui) return;
    let active = true;
    void ui
      .getInfo()
      .then((value) => {
        if (active) setLoaded(value);
      })
      .catch((error) => console.error("Could not read desktop UI source", error));
    return () => {
      active = false;
    };
  }, [ui]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes the active connected environment and its runtime version with the shell's stable-origin UI proxy
  useEffect(() => {
    if (!ui || !loaded || !environmentId || !httpBaseUrl || !version) return;
    let active = true;
    let cancelReload: (() => void) | undefined;
    void ui
      .select({ environmentId, httpBaseUrl, serverVersion: version })
      .then((changed) => {
        if (active && changed) {
          cancelReload = afterChatSendsSettled(() => {
            if (!active) return;
            try {
              flushComposerDrafts();
              window.location.reload();
            } catch (error) {
              console.error("Could not reload connected server UI", error);
            }
          });
        }
      })
      .catch((error) => console.error("Could not select connected server UI", error));
    return () => {
      active = false;
      cancelReload?.();
    };
  }, [ui, loaded, environmentId, httpBaseUrl, version]);
  return null;
}
