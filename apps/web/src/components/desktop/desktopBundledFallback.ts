/** What the desktop shell adds when it serves the bundled client instead of the server UI. */
export interface DesktopBundledFallback {
  /** The server address the desktop tried to reach, when it knew one. */
  readonly server: string | null;
}

export function desktopBundledFallback(search: string): DesktopBundledFallback | null {
  const params = new URLSearchParams(search);
  if (params.get("bundled") !== "1") return null;
  return { server: params.get("server") };
}

function safeUrl(value: string | null): URL | null {
  if (value === null) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** A short, credential-free name for the server the shell could not reach. */
export function desktopFallbackServerLabel(server: string | null): string {
  const url = safeUrl(server);
  if (!url) return "the server";
  return url.host || url.href;
}

/**
 * Retry by asking the shell for the server UI again: removing `bundled` makes
 * the custom protocol try the saved server origin and fall back here only if it
 * still cannot answer.
 */
export function desktopBundledRetryUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("bundled");
  url.searchParams.delete("server");
  return url.toString();
}
