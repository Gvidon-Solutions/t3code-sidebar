import type { MeshLayoutDocument } from "@t3tools/shared/meshLayout";

const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

export function missingBarrierEntries(
  barrier: MeshLayoutDocument,
  documents: readonly MeshLayoutDocument[],
) {
  const collected = new Set(
    Object.entries(barrier)
      .filter(([key, entry]) => entry.v === null && documents.every((doc) => !doc[key]))
      .map(([key]) => key),
  );
  return documents.map((document) =>
    Object.entries(barrier).flatMap(([key, entry]) =>
      collected.has(key) ||
      (document[key] &&
        document[key].h >= entry.h &&
        (document[key].h !== entry.h || canonical(document[key].v) === canonical(entry.v)))
        ? []
        : [
            {
              key,
              expected: entry.h,
              actual: document[key]?.h,
              sameValue: canonical(document[key]?.v) === canonical(entry.v),
            },
          ],
    ),
  );
}
