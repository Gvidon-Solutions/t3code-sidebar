import { Project } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export const ProjectHandle = Schema.Struct({
  id: Project.fields.id,
  title: Project.fields.title,
  workspaceRoot: Project.fields.workspaceRoot,
  repositoryIdentity: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        canonicalKey: Schema.String,
        origin: Schema.optionalKey(Schema.Struct({ canonicalKey: Schema.String })),
      }),
    ),
  ),
  createdAt: Project.fields.createdAt,
});
export type ProjectHandle = typeof ProjectHandle.Type;
export const ProjectCatalog = Schema.Struct({
  environmentId: Schema.String,
  h: Schema.String,
  projects: Schema.Array(ProjectHandle),
});
export type ProjectCatalog = typeof ProjectCatalog.Type;
export const CatalogClocks = Schema.Record(Schema.String, Schema.String);
export class MeshProjectDirectory extends Context.Service<
  MeshProjectDirectory,
  {
    readonly read: Effect.Effect<readonly ProjectCatalog[]>;
    readonly changes: Stream.Stream<readonly ProjectCatalog[]>;
    readonly accept: (catalogs: readonly ProjectCatalog[]) => Effect.Effect<void>;
  }
>()("t3/mesh/MeshProjectDirectory") {}

export const layer = Layer.effect(
  MeshProjectDirectory,
  Effect.gen(function* () {
    const catalogs = yield* Ref.make<ReadonlyMap<string, ProjectCatalog>>(new Map());
    const updates = yield* PubSub.unbounded<readonly ProjectCatalog[]>();
    const read = Ref.get(catalogs).pipe(
      Effect.map((all) =>
        [...all.values()].sort((a, b) => a.environmentId.localeCompare(b.environmentId)),
      ),
    );
    const accept = Effect.fn("MeshProjectDirectory.accept")(function* (
      incoming: readonly ProjectCatalog[],
    ) {
      const changed = yield* Ref.modify(catalogs, (old) => {
        const next = new Map(old);
        for (const entry of incoming)
          if (!next.has(entry.environmentId) || next.get(entry.environmentId)!.h < entry.h)
            next.set(entry.environmentId, entry);
        return [[...next].some(([id, entry]) => old.get(id) !== entry), next] as const;
      });
      if (changed) yield* PubSub.publish(updates, yield* read);
    });
    const changes = Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* PubSub.subscribe(updates);
        return Stream.concat(Stream.fromEffect(read), Stream.fromSubscription(queue));
      }),
    );
    return MeshProjectDirectory.of({ read, accept, changes });
  }),
);
