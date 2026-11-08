export function withoutMeshThreadHeader(text: string) {
  return text.replace(/(^|\n\n)Thread [^\n]+\n\nUser message:\n/, (_match, prefix: string) =>
    prefix ? `${prefix}User message:\n` : "",
  );
}

export function withoutMeshThreadHeaders(value: unknown): unknown {
  if (typeof value === "string") return withoutMeshThreadHeader(value);
  if (Array.isArray(value)) return value.map(withoutMeshThreadHeaders);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, withoutMeshThreadHeaders(item)]),
  );
}
