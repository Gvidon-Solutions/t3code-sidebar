import { useState } from "react";
import { Pressable, View } from "react-native";
import * as Result from "effect/Result";
import { EnvironmentId } from "@t3tools/contracts";
import { AuthAccessWriteScope } from "@t3tools/contracts";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import {
  linkMeshMachines,
  type MeshMachine,
  type MeshLinkSource,
} from "@t3tools/client-runtime/state/mesh-machines";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { mintPairingCodeOn } from "../../state/peerPairingCode";
import { useAtomCommand } from "../../state/use-atom-command";
import { meshLinkSourceOptions, meshLinkTargets } from "./mesh-settings.logic";

export function MeshLinkForm(props: {
  readonly machines: readonly MeshMachine[];
  readonly onDone: () => void;
  readonly links: ReadonlyArray<MeshLinkSource>;
}) {
  const { environments } = useEnvironments();
  const permitted = useEnvironmentsWithScope(environments, AuthAccessWriteScope);
  const sources = meshLinkSourceOptions(environments)
    .filter((source) => permitted.has(source.environmentId))
    .map((source) => ({
      ...source,
      label:
        props.machines.find((machine) => machine.environmentId === source.environmentId)?.label ??
        source.label,
    }));
  const [source, setSource] = useState(sources[0]?.environmentId ?? null);
  const [target, setTarget] = useState<MeshMachine | null>(null);
  const canMint =
    useEnvironmentScope(
      target === null ? null : EnvironmentId.make(target.environmentId),
      AuthAccessWriteScope,
    ) && target?.connectedHere === true;
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const link = useAtomCommand(peerLinkEnvironment.link, { label: "link machine" });
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, {
    label: "unlink machine",
    reportFailure: true,
  });
  const submit = async () => {
    if (!source || source === target?.environmentId || !url.trim()) return;
    const chosenTarget =
      target === null
        ? null
        : { environmentId: EnvironmentId.make(target.environmentId), label: target.label };
    setBusy(true);
    try {
      const result = await linkMeshMachines({
        source,
        target: chosenTarget,
        url,
        code,
        mintOnTarget: canMint,
        mintCode: async (id) => {
          const minted = await mintPairingCodeOn(id, "full-access");
          if (Result.isFailure(minted)) throw new Error(String(minted.failure));
          return minted.success;
        },
        link: (environmentId, input) => link({ environmentId, input }),
      });
      if (result._tag === "Success") props.onDone();
      else if (!isAtomCommandInterrupted(result))
        Dialog.alert("Could not link machine", String(squashAtomCommandFailure(result)));
    } catch (error) {
      Dialog.alert("Could not link machine", String(error));
    }
    setBusy(false);
  };
  return (
    <View className="gap-3 p-4">
      <Text>Full access is needed for machines to exchange the mesh layout.</Text>
      <Text>Link from</Text>
      {sources.map((e) => (
        <Pressable
          accessibilityRole="button"
          className="min-h-[45px] justify-center"
          key={e.environmentId}
          disabled={busy}
          onPress={() => {
            setSource(e.environmentId);
            setTarget(null);
          }}
        >
          <Text>
            {e.environmentId === source ? "✓ " : ""}
            {e.label}
          </Text>
        </Pressable>
      ))}
      <Text>Link to</Text>
      {meshLinkTargets(props.machines, source).map((m) => (
        <Pressable
          accessibilityRole="button"
          className="min-h-[45px] justify-center"
          key={m.environmentId}
          disabled={busy}
          onPress={() => {
            setTarget(m);
            setUrl(m.urls[0] ?? "");
            setCode("");
          }}
        >
          <Text>
            {m.environmentId === target?.environmentId ? "✓ " : ""}
            {m.label}
          </Text>
        </Pressable>
      ))}
      <>
        {(target?.urls ?? []).map((address) => (
          <Pressable
            accessibilityRole="button"
            className="min-h-[45px] justify-center"
            key={address}
            onPress={() => setUrl(address)}
          >
            <Text>{address}</Text>
          </Pressable>
        ))}
        <AppTextInput
          className="min-h-[45px]"
          accessibilityLabel="Machine address"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          placeholder="https://machine"
        />
        {canMint ? (
          <Text>A pairing code will be created for you.</Text>
        ) : (
          <AppTextInput
            className="min-h-[45px]"
            accessibilityLabel="Pairing code"
            value={code}
            onChangeText={setCode}
            placeholder="Code from Connections on that machine"
          />
        )}
        <Pressable
          accessibilityRole="button"
          className="min-h-[45px] justify-center"
          disabled={busy || !source || !url.trim() || (!canMint && !code.trim())}
          onPress={() => void submit()}
        >
          <Text>{busy ? "Linking…" : "Link"}</Text>
        </Pressable>
      </>
      {props.machines.flatMap((m) =>
        m.linkedWith.map((from) => (
          <Pressable
            accessibilityRole="button"
            className="min-h-[45px] justify-center"
            key={`${from.environmentId}:${m.environmentId}`}
            onPress={() =>
              Dialog.confirm({
                title: `Unlink ${from.label} from ${m.label}?`,
                message: "The shared layout stays on both machines.",
                confirmText: "Unlink",
                destructive: true,
                onConfirm: () => {
                  const forward = props.links.some(
                    (source) =>
                      source.environmentId === from.environmentId &&
                      source.links.some((peer) => peer.environmentId === m.environmentId),
                  );
                  void unlink({
                    environmentId: EnvironmentId.make(
                      forward ? from.environmentId : m.environmentId,
                    ),
                    input: {
                      environmentId: EnvironmentId.make(
                        forward ? m.environmentId : from.environmentId,
                      ),
                    },
                  });
                },
              })
            }
          >
            <Text>
              Unlink {from.tag} from {m.tag}
            </Text>
          </Pressable>
        )),
      )}
    </View>
  );
}
