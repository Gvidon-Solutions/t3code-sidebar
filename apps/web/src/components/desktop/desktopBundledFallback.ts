/** What the desktop shell adds when it serves the bundled client instead of the server UI. */
export interface DesktopBundledFallback {
  /** The server address the desktop tried to reach, when it knew one. */
  readonly server: string | null;
  /** The configured machine name of that server, when the shell knows it. */
  readonly name: string | null;
}

export function desktopBundledFallback(search: string): DesktopBundledFallback | null {
  const params = new URLSearchParams(search);
  if (params.get("bundled") !== "1") return null;
  return { server: params.get("server"), name: params.get("name") };
}

function safeUrl(value: string | null): URL | null {
  if (value === null) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** The name to use in the offline page: the configured machine, else a short server name. */
export function desktopFallbackServerLabel(fallback: DesktopBundledFallback): string {
  const name = fallback.name?.trim();
  if (name) return name;
  const url = safeUrl(fallback.server);
  if (url === null) return "the server";
  if (isLoopback(url.hostname)) return "this machine";
  return url.hostname.split(".")[0]?.trim() || "the server";
}

/** The attempted address as a muted detail line; never part of the sentence. */
export function desktopFallbackServerAddress(fallback: DesktopBundledFallback): string | null {
  const url = safeUrl(fallback.server);
  return url === null ? null : url.host;
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
  url.searchParams.delete("name");
  return url.toString();
}
