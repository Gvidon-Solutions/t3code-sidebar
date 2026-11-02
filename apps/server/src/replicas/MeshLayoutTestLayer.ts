import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
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
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";

export const layerTest = (environmentId: string, initial: SidebarWorkspacesConfig) =>
  Layer.effect(
    MeshLayoutService,
    Effect.gen(function* () {
      const document = yield* Ref.make<MeshLayoutDocument>(
        diff(materialize({}), initial, {}, tick(0, null, environmentId)),
      );
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
