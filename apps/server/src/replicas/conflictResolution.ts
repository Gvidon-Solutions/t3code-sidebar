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
  return `.t3-conflicts/${iso.replace(/[:.]/g, "-")}/${relative}`;
}

export function conflictRoots(paths: readonly string[]): string[] {
  return [...new Set(paths)]
    .sort()
    .filter((p, i, all) => !all.slice(0, i).some((parent) => p.startsWith(`${parent}/`)));
}
