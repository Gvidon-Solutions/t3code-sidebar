import { resolvePrimaryEnvironmentHttpUrl } from "./target";

let desktopBearerTokenPromise: Promise<string> | null = null;

export function readDesktopPrimaryBearerToken(): Promise<string | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.desktopBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  desktopBearerTokenPromise ??= bridge.getLocalEnvironmentBearerToken().catch((error) => {
    desktopBearerTokenPromise = null;
    throw error;
  });
  return desktopBearerTokenPromise;
}

/**
 * The server UI reaches its API through the shell's same-origin proxy, so it cannot
 * read the session cookie. It mints a short-lived RPC ticket instead.
 */
export async function readServerUiWebSocketTicket(): Promise<string | null> {
  if (typeof window === "undefined" || window.desktopShell === undefined) {
    return null;
  }
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/websocket-ticket/rpc"), {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Server UI WebSocket ticket request failed (HTTP ${response.status}).`);
  }
  const body: unknown = await response.json();
  const ticket =
    typeof body === "object" && body !== null && "ticket" in body ? body.ticket : undefined;
  return typeof ticket === "string" && ticket.length > 0 ? ticket : null;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
}
