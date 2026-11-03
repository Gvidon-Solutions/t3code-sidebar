import { keys, type MeshLayoutDocument, type MeshLayoutEntry } from "./document.ts";

export function recordLayoutAuthors(
  entries: MeshLayoutDocument,
  environmentId: string,
): MeshLayoutDocument {
  const result = { ...entries };
  for (const [key, entry] of Object.entries(entries)) {
    if (/^(ws|rep)\//.test(key))
      result[keys.author(entry.h, environmentId)] = { v: true, h: entry.h };
  }
  return result;
}

export function authoredBy(
  doc: MeshLayoutDocument,
  entry: MeshLayoutEntry | undefined,
  environmentId: string | undefined,
): boolean {
  return Boolean(
    entry &&
    environmentId &&
    (entry.h.slice(20) === environmentId || doc[keys.author(entry.h, environmentId)]?.v === true),
  );
}
