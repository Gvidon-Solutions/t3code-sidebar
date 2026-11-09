const RECONNECT_RETRY_MS = 1_000;
const RECONNECT_MAX_WAIT_MS = 120_000;
const SESSION_PATH = "/api/auth/session";

const CHUNK_FAILURE_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
  /error loading dynamically imported module/i,
  /loading chunk .* failed/i,
];

export function isChunkLoadFailure(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "";
  return CHUNK_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

export function isServerUiWindow(): boolean {
  return typeof window !== "undefined" && window.desktopShell !== undefined;
}

export function serverUiLabel(): string {
  const name = window.desktopShell?.name;
  if (typeof name === "string" && name.trim().length > 0) return name.trim();
  return "this server";
}

function installReconnectingSurface(): void {
  const host = document.getElementById("boot-shell") ?? document.body;
  if (host === null) return;
  const main = document.createElement("main");
  main.id = "server-ui-reconnect";
  main.setAttribute("role", "status");
  main.setAttribute("aria-live", "polite");
  main.style.cssText =
    "display:flex;min-height:100vh;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;font:15px system-ui,sans-serif";
  const title = document.createElement("h1");
  title.textContent = `Reconnecting to ${serverUiLabel()}…`;
  title.style.cssText = "margin:0;font-size:20px;font-weight:600";
  const detail = document.createElement("p");
  detail.textContent = "The server is restarting. This page reloads as soon as it is back.";
  detail.style.cssText = "margin:0;max-width:420px;line-height:1.6;color:#7a7a7a";
  const fallback = document.createElement("button");
  fallback.type = "button";
  fallback.textContent = "Use the built-in version";
  fallback.title = "Works offline with your saved connections";
  fallback.style.cssText =
    "margin-top:8px;padding:8px 14px;border-radius:8px;border:1px solid #555;background:transparent;font:inherit;cursor:pointer";
  const fallbackNote = document.createElement("p");
  fallbackNote.textContent = "Works offline with your saved connections.";
  fallbackNote.style.cssText = "margin:0;max-width:420px;font-size:13px;color:#7a7a7a";
  fallback.addEventListener("click", () => window.desktopShell?.returnToBundled());
  main.append(title, detail, fallback, fallbackNote);
  host.replaceChildren(main);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function nextSessionState(): Promise<"ready" | "rejected" | "unavailable"> {
  try {
    const response = await fetch(SESSION_PATH, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (response.ok) return "ready";
    if (response.status === 401 || response.status === 403) return "rejected";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

let reconnecting = false;

/** Waits for the server after a chunk failure, then reloads, or falls back to bundled UI. */
export async function beginServerUiReconnect(): Promise<void> {
  if (reconnecting || !isServerUiWindow()) return;
  reconnecting = true;
  installReconnectingSurface();
  const startedAt = Date.now();
  while (Date.now() - startedAt < RECONNECT_MAX_WAIT_MS) {
    const state = await nextSessionState();
    if (state === "ready") {
      window.location.reload();
      return;
    }
    if (state === "rejected") {
      window.desktopShell?.returnToBundled();
      return;
    }
    await wait(RECONNECT_RETRY_MS);
  }
  window.desktopShell?.returnToBundled();
}

export function installServerUiReconnect(): () => void {
  if (!isServerUiWindow()) return () => {};
  const onPreloadError = (event: Event) => {
    event.preventDefault();
    void beginServerUiReconnect();
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if (!isChunkLoadFailure(event.reason)) return;
    event.preventDefault();
    void beginServerUiReconnect();
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("vite:preloadError", onPreloadError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
