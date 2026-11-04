import { MeshConfigRevision } from "@t3tools/contracts";
import { migrateConfig } from "@t3tools/shared/meshConfig/migration";
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
    if (Object.hasOwn(snapshot.document, "mesh.config")) return;
    const self = yield* (yield* ServerEnvironment).getDescriptor;
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
    for (const [name, environmentId] of Object.entries(migration.bindings))
      entries[`mesh.machineBinding/${name}`] = { v: environmentId, h };
    yield* mesh.apply(entries);
  }),
);
