export function withoutMeshThreadHeader(text: string) {
  return text.replace(/(^|\n\n)Thread [^\n]+\n\nUser message:\n/, (_match, prefix: string) =>
    prefix ? `${prefix}User message:\n` : "",
  );
}
