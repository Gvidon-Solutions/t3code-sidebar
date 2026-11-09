/** What the desktop shell adds when it serves the bundled client instead of the server UI. */
export interface DesktopBundledFallback {
  /** The server address the desktop tried to reach, when it knew one. */
  readonly server: string | null;
  /** The configured machine name of that server, when the shell knows it. */
  readonly name: string | null;
  /** Server-UI authentication failed; the saved connections are not an outage. */
  readonly auth?: true;
}

/** Longest machine name the offline page shows; a hostile or broken name cannot overflow the title. */
export const DESKTOP_FALLBACK_NAME_MAX = 60;

export function desktopBundledFallback(search: string): DesktopBundledFallback | null {
  const params = new URLSearchParams(search);
  if (params.get("bundled") !== "1") return null;
  return {
    server: params.get("server"),
    name: params.get("name"),
    ...(params.get("auth") === "1" ? ({ auth: true } as const) : {}),
  };
}

/**
 * The bundled client only replaces the whole app when there is no way into the
 * local settings. Settings routes keep the normal branch so the person can choose
 * another saved server instead of being stuck on the offline page.
 */
export function showsDesktopBundledFallback(input: {
  readonly fallback: DesktopBundledFallback | null;
  readonly pathname: string;
}): boolean {
  if (input.fallback === null || input.fallback.auth === true) return false;
  return !/^\/settings(\/|$)/u.test(input.pathname);
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

/** IPv4 or IPv6 literals are addresses, never a machine name. */
function isIpLiteral(hostname: string): boolean {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/u.test(bare) || (/^[0-9a-f:]+$/iu.test(bare) && bare.includes(":"))
  );
}

/** The name to use in the offline page: the configured machine, else a short server name. */
export function desktopFallbackServerLabel(fallback: DesktopBundledFallback): string {
  const name = fallback.name?.trim();
  if (name) return name.slice(0, DESKTOP_FALLBACK_NAME_MAX);
  const url = safeUrl(fallback.server);
  if (url === null) return "the server";
  if (isLoopback(url.hostname)) return "this machine";
  if (isIpLiteral(url.hostname)) return "the server";
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

/**
 * The offline page's second action: the bundled client's Settings › Connections,
 * where the person can switch to another saved server. The hash is the router
 * path because desktop uses hash history.
 */
export function desktopBundledLocalSettingsUrl(href: string): string {
  const url = new URL(href);
  url.hash = "/settings/connections";
  return url.toString();
}
