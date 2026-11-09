import { type DesktopUiInfo } from "@t3tools/contracts";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { afterChatSendsSettled } from "../chat/draftSendState";
import { DraftId, flushComposerDrafts, useComposerDraftStore } from "../../composerDraftStore";
import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { readPreparedConnection } from "../../state/session";
import {
  useEnvironments,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { resolveServerUiSource } from "./serverUiSource";
import { withoutBundledFallback } from "./desktopBundledFallback";

function serverUiSelectionUrl(httpBaseUrl: string, shellOrigin: string | undefined): string {
  try {
    const protocol = new URL(httpBaseUrl).protocol;
    if (protocol === "t3code:" || protocol === "t3code-dev:") {
      return shellOrigin ?? httpBaseUrl;
    }
  } catch {
    // A malformed target is reported by the selection call; keep the value for that error.
  }
  return httpBaseUrl;
}

export function DesktopUiCoordinator() {
  const ui = window.desktopBridge?.ui ?? window.desktopShell?.ui;
  const [loaded, setLoaded] = useState<DesktopUiInfo | null>(null);
  const routeEnvironment = useParams({ strict: false, select: (params) => params.environmentId });
  const draftId = useParams({ strict: false, select: (params) => params.draftId });
  const draftEnvironment = useComposerDraftStore((state) =>
    draftId ? state.getDraftSession(DraftId.make(draftId))?.environmentId : undefined,
  );
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [remembered, setRemembered] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
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
    void (async () => {
      const trustedClient = window.desktopBridge !== undefined;
      const sourceHttpBaseUrl = serverUiSelectionUrl(
        httpBaseUrl,
        window.desktopShell?.origin ?? undefined,
      );
      const primaryBearerToken =
        trustedClient && environmentId === PRIMARY_LOCAL_ENVIRONMENT_ID
          ? await readDesktopPrimaryBearerToken().catch((error) => {
              console.warn("Could not read the desktop local credential", error);
              return null;
            })
          : null;
      const source = resolveServerUiSource({
        environmentId,
        httpBaseUrl: sourceHttpBaseUrl,
        prepared: readPreparedConnection(environmentId),
        primaryBearerToken,
        trustedClient,
      });
      const changed = await ui.select({
        environmentId,
        httpBaseUrl: source.httpBaseUrl,
        serverVersion: version,
      });
      if (!active) return;
      if (!changed) {
        // A rejected server UI is retried after its TTL; keep this bundled app polling
        // so a plain document load can pick the server UI up again.
        if (loaded.source === "bundled" && environmentId !== null) {
          const timer = setTimeout(() => setRetryNonce((value) => value + 1), 30_000);
          cancelReload = () => clearTimeout(timer);
        }
        return;
      }
      cancelReload = afterChatSendsSettled(() => {
        if (!active) return;
        try {
          flushComposerDrafts();
          window.location.assign(withoutBundledFallback(window.location.href));
        } catch (error) {
          console.error("Could not reload connected server UI", error);
        }
      });
    })().catch((error) => console.error("Could not select connected server UI", error));
    return () => {
      active = false;
      cancelReload?.();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- retryNonce re-runs the source sync after the bundled retry timer
  }, [ui, loaded, environmentId, httpBaseUrl, version, retryNonce]);
  return null;
}
