import { useAtomValue } from "@effect/atom-react";
import { linkAccessLabel } from "@t3tools/client-runtime/link-request";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import {
  meshLinkedWithText,
  type MeshMachine,
  type MeshPeerLinkView,
} from "@t3tools/client-runtime/state/mesh-machines";
import { type EnvironmentId, type SidebarWorkspacesConfig } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useAtomCommand } from "../../state/use-atom-command";

/** The peers a machine links to, with the Forget action that used to sit on Connections. */
export function MachineLinkedPeers(props: {
  readonly machine: MeshMachine;
  readonly config: SidebarWorkspacesConfig;
  readonly links: ReadonlyArray<MeshPeerLinkView>;
}) {
  const unlink = useAtomCommand(peerLinkEnvironment.unlink);
  const canUnlink = useAtomValue(
    peerLinkEnvironment.unlink.permissionAtom(props.machine.environmentId as EnvironmentId),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const names = props.links.length
    ? meshLinkedWithText(props.config, props.links)
    : props.machine.linkedWith.map((peer) => peer.label).join(", ") || null;
  if (names === null) return null;
  const forget = (link: Pick<MeshPeerLinkView, "environmentId" | "label">) => {
    const label = machineDisplayOf(props.config, link.environmentId, link.label).label;
    Dialog.confirm({
      title: "Forget this link?",
      message: `Forget ${label}? Agents here stop working there. Revoke "T3 Code · …" in ${label}'s Connections to end the session there too.`,
      confirmText: "Forget",
      destructive: true,
      onConfirm: () => {
        setBusy(link.environmentId);
        void unlink({
          environmentId: props.machine.environmentId as EnvironmentId,
          input: { environmentId: link.environmentId as EnvironmentId },
        }).then((result) => {
          setBusy(null);
          if (result._tag === "Failure")
            Dialog.alert("Could not forget the link", "Try again from Settings › Mesh.");
        });
      },
    });
  };
  return (
    <View className="gap-1 border-t border-border-subtle pt-3">
      <AppText className="text-xs text-foreground-muted">
        <AppText className="text-foreground">Linked with</AppText> {names}
      </AppText>
      {props.links.length > 0 && canUnlink
        ? props.links.map((link) => {
            const name = machineDisplayOf(props.config, link.environmentId, link.label).label;
            return (
              <View
                key={link.environmentId}
                className="flex-row items-center justify-between gap-2"
              >
                <AppText className="text-xs text-foreground-muted">
                  {name}
                  {link.access === undefined ? "" : ` · ${linkAccessLabel(link.access)}`}
                </AppText>
                <Button
                  label={busy === link.environmentId ? "Forgetting…" : "Forget"}
                  tone="secondary"
                  disabled={busy !== null}
                  onPress={() => forget(link)}
                />
              </View>
            );
          })
        : null}
    </View>
  );
}
