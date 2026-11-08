import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import {
  diff,
  materialize,
  merge,
  tick,
  type MeshLayoutDocument,
} from "@t3tools/shared/meshLayout";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import { MeshLayoutService } from "../src/mesh/MeshLayoutService.ts";

export const layerTest = (
  environmentId: string,
  initial: SidebarWorkspacesConfig,
  extra: MeshLayoutDocument = {},
) =>
  Layer.effect(
    MeshLayoutService,
    Effect.gen(function* () {
      const document = yield* Ref.make<MeshLayoutDocument>({
        ...diff(materialize({}), initial, {}, tick(0, null, environmentId)),
        ...extra,
      });
      const clock = yield* Ref.make(tick(0, null, environmentId));
      const changes = yield* PubSub.unbounded<{
        document: MeshLayoutDocument;
        config: SidebarWorkspacesConfig;
      }>();
      const lock = yield* Semaphore.make(1);
      const read = Ref.get(document).pipe(
        Effect.map((document) => ({ document, config: materialize(document) })),
      );
      const nextHlc = Ref.updateAndGet(clock, (last) => tick(0, last, environmentId));
      const apply = Effect.fn("MeshLayoutTestLayer.apply")(function* (entries: MeshLayoutDocument) {
        yield* Ref.update(document, (current) => merge(current, entries));
        const snapshot = yield* read;
        yield* PubSub.publish(changes, snapshot);
        return snapshot;
      });
      return MeshLayoutService.of({
        environmentId,
        read,
        nextHlc,
        apply,
        edit: Effect.fn("MeshLayoutTestLayer.edit")((update) =>
          lock.withPermit(
            Effect.gen(function* () {
              const before = yield* read;
              return yield* apply(
                diff(before.config, update(before.config), before.document, yield* nextHlc),
              );
            }),
          ),
        ),
        editLegacy: Effect.fn("MeshLayoutTestLayer.editLegacy")((before, after) =>
          lock.withPermit(
            Effect.gen(function* () {
              const current = yield* read;
              return yield* apply(diff(before, after, current.document, yield* nextHlc));
            }),
          ),
        ),
        changes: Stream.fromEffect(read).pipe(Stream.concat(Stream.fromPubSub(changes))),
      });
    }),
  );

export const linkedTestDocument = (
  bindings: Readonly<Record<string, string>>,
  h = "0000000000000.00000.fixture",
  files: "all" | "projects" = "projects",
): MeshLayoutDocument => ({
  "mesh.config": {
    h,
    v: {
      revision: h,
      author: "fixture",
      writtenAt: "",
      doc: {
        schema: 1,
        links: { default: { files } },
        machines: Object.fromEntries(Object.keys(bindings).map((name) => [name, {}])),
      },
    },
  },
  ...Object.fromEntries(
    Object.entries(bindings).map(([name, id]) => [
      `mesh.machineBinding/${encodeURIComponent(name)}`,
      { h, v: id },
    ]),
  ),
});
export const layerLinkedTest = (
  environmentId: string,
  bindings: Readonly<Record<string, string>>,
  files: "all" | "projects" = "projects",
) =>
  layerTest(
    environmentId,
    DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    linkedTestDocument(bindings, undefined, files),
  );
