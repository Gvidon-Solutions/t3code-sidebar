import { canonical, merge, type MeshLayoutDocument } from "@t3tools/shared/meshLayout";

export const captureBarrier = (documents: readonly MeshLayoutDocument[]) =>
  documents.reduce(merge, {});

export const hasReachedBarrier = (barrier: MeshLayoutDocument, document: MeshLayoutDocument) =>
  Object.entries(barrier).every(([key, entry]) => {
    const observed = Object.hasOwn(document, key) ? document[key] : undefined;
    return (
      observed &&
      (observed.h > entry.h ||
        (observed.h === entry.h && canonical(observed.v) === canonical(entry.v)))
    );
  });
