/** Resolve chains completely; cycles resolve to their smallest member, independent of entry path. */
export function resolveAlias(aliases: Readonly<Record<string, string>>, key: string): string {
  const path: string[] = [];
  const positions = new Map<string, number>();
  while (Object.hasOwn(aliases, key) && aliases[key]) {
    const cycle = positions.get(key);
    if (cycle !== undefined) return path.slice(cycle).sort()[0]!;
    positions.set(key, path.length);
    path.push(key);
    key = aliases[key]!;
  }
  return key;
}
