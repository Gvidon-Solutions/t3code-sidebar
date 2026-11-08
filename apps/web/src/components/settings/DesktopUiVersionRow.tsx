import { Button } from "../ui/button";
import type { DesktopUiInfo } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { APP_VERSION } from "../../branding";
import { SettingsRow } from "./settingsLayout";

export function DesktopUiVersionRow() {
  const ui = window.desktopBridge?.ui ?? window.desktopShell?.ui;
  const [source, setSource] = useState<DesktopUiInfo | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Electron shell's actual loaded UI source and fallback status over IPC
  useEffect(() => {
    if (!ui) return;
    let active = true;
    void ui
      .getInfo()
      .then((value) => {
        if (active) setSource(value);
      })
      .catch((error) => console.error("Could not read desktop UI version", error));
    return () => {
      active = false;
    };
  }, [ui]);
  if (!source) return null;
  const origin =
    source.source === "bundled"
      ? "Bundled offline copy"
      : source.source === "development"
        ? "Development UI"
        : source.origin;
  return (
    <SettingsRow
      title={`UI ${APP_VERSION} · shell ${source.shellVersion}`}
      control={
        window.desktopShell?.returnToBundled ? (
          <Button variant="outline" size="sm" onClick={window.desktopShell.returnToBundled}>
            Open desktop settings
          </Button>
        ) : undefined
      }
      description={`${origin}${source.source === "server" ? ` · server ${source.version}` : ""}${source.reason ? ` · ${source.reason}` : ""}`}
    />
  );
}
