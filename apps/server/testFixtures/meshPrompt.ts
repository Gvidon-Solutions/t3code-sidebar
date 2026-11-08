export function withoutMeshThreadHeader(text: string) {
  return text.replace(/^Thread [^\n]+\n\nUser message:\n/, "");
}
