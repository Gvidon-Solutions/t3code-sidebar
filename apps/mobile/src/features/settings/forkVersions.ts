// Sidebar fork: order the fork's published APKs and describe a download.

const FORK_VERSION = /^(\d+)\.(\d+)\.(\d+)-sidebar\.(\d+)$/;

function versionParts(version: string): ReadonlyArray<number> {
  const match = FORK_VERSION.exec(version);
  return match ? match.slice(1).map(Number) : [];
}

/** Newest first: by the base version, then by the sidebar build number. */
export function compareForkVersionsNewestFirst(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? -1) - (a[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whole percent downloaded, or null while the size is unknown. */
export function downloadPercent(progress: {
  readonly bytesWritten: number;
  readonly totalBytes: number;
}): number | null {
  if (progress.totalBytes <= 0) return null;
  return Math.min(100, Math.floor((progress.bytesWritten / progress.totalBytes) * 100));
}
