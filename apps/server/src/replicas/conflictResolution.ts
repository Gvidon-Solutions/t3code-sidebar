export function conflictRoots(paths: readonly string[]): string[] {
  return [...new Set(paths)]
    .sort()
    .filter((p, i, all) => !all.slice(0, i).some((parent) => p.startsWith(`${parent}/`)));
}
