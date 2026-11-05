import * as HostProcess from "@t3tools/shared/HostProcess";
import { MeshConfigRevision } from "@t3tools/contracts";
import { localMachineClaim } from "@t3tools/shared/meshConfig";
import { migrateConfig, extractConfigMigration } from "@t3tools/shared/meshConfig/migration";
import type { Json, MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";

const encodeRevision = Schema.encodeEffect(MeshConfigRevision);

/** Writes the first config revision from the legacy layout, once. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const mesh = yield* MeshLayoutService;
    const snapshot = yield* mesh.read;
    const self = yield* (yield* ServerEnvironment).getDescriptor;
    if (Object.hasOwn(snapshot.document, "mesh.config")) {
      const entries = extractConfigMigration(snapshot.document, yield* mesh.nextHlc);
      Object.assign(entries, localMachineClaim(snapshot.document, self, yield* mesh.nextHlc));
      if (Object.keys(entries).length) yield* mesh.apply(entries);
      return;
    }
    if ((yield* HostProcess.Environment).T3_MESH_JOINING === "1") return;
    const settings = yield* (yield* ServerSettingsService).getSettings;
    const peers = yield* (yield* PeerLinks).list;
    const migration = migrateConfig(
      snapshot.document,
      snapshot.config,
      self,
      peers,
      settings.replicaIgnores,
    );
    if (!migration) return;
    const h = yield* mesh.nextHlc;
    const revision = {
      sequence: 1,
      revision: h,
      doc: migration.doc,
      author: mesh.environmentId,
      writtenAt: DateTime.formatIso(yield* DateTime.now),
    };
    const value = (yield* encodeRevision(revision)) as Json;
    const entries: MeshLayoutDocument = {
      "mesh.config": { v: value, h },
      [`mesh.configHistory/${encodeURIComponent(h)}`]: { v: value, h },
    };
    for (const [name, environmentId] of Object.entries(migration.bindings)) {
      entries[`mesh.machineBinding/${name}`] = { v: environmentId, h };
      entries[`mesh.machineClaim/${encodeURIComponent(environmentId)}`] = {
        v: { name, machine: migration.doc.machines[name]! } as Json,
        h,
      };
    }
    for (const [name, metadata] of Object.entries(migration.migration))
      entries[`mesh.machineMigration/${encodeURIComponent(name)}`] = { v: metadata as Json, h };
    yield* mesh.apply(entries);
  }),
);
