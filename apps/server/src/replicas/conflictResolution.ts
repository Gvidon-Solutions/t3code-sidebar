export function conflictCopyPath(iso: string, relative: string): string {
  if (!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(iso)) throw new Error("Invalid conflict timestamp");
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    relative.split("/").some((p) => !p || p === "." || p === "..") ||
    relative.split("/")[0] === ".t3-conflicts"
  )
    throw new Error("Unsafe conflict path");
  return `.t3-conflicts/${iso}/${relative}`;
}

export function conflictRoots(paths: readonly string[]): string[] {
  return [...new Set(paths)]
    .sort()
    .filter((p, i, all) => !all.slice(0, i).some((parent) => p.startsWith(`${parent}/`)));
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function preserveConflictCommand(
  root: string,
  iso: string,
  paths: readonly string[],
): string {
  const commands = conflictRoots(paths).map((relative) => {
    const copy = conflictCopyPath(iso, relative);
    const parent = copy.slice(0, copy.lastIndexOf("/"));
    const parents = [
      ...new Set([
        ".t3-conflicts",
        `.t3-conflicts/${iso}`,
        ...relative
          .split("/")
          .slice(0, -1)
          .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
        ...parent.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/")),
      ]),
    ];
    const guards = parents.map((p) => `test ! -L ${quote(p)}`).join(" && ");
    return `${guards} || exit 1; if [ -e ${quote(relative)} ] || [ -L ${quote(relative)} ]; then mkdir -p -- ${quote(parent)} && test ! -e ${quote(copy)} && test ! -L ${quote(copy)} && mv -- ${quote(relative)} ${quote(copy)} || exit 1; fi`;
  });
  return `set -eu; cd -- ${quote(root)}; ${commands.join("; ")}`;
}
