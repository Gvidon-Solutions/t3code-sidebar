import { normalizeProjectPathForComparison, isWindowsDrivePath, isUncPath } from "../path.ts";

export function normalizeRepresentationPath(value: string): string {
  const normalized = normalizeProjectPathForComparison(value);
  const windows = isWindowsDrivePath(normalized) || isUncPath(normalized);
  const uniform = windows ? normalized.replaceAll("\\", "/").toLowerCase() : normalized;
  const prefix = uniform.startsWith("//")
    ? "//"
    : uniform.startsWith("/")
      ? "/"
      : (uniform.match(/^[a-z]:\//)?.[0] ?? "");
  const parts: string[] = [];
  const protectedParts = prefix === "//" ? 2 : 0;
  for (const part of uniform.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > protectedParts && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !prefix) parts.push(part);
  }
  const result = prefix + parts.join("/");
  return windows ? result.replaceAll("/", "\\") : result || (normalized ? "." : "");
}
