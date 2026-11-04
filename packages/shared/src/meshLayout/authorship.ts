import { keys, type MeshLayoutDocument } from "./document.ts";

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
