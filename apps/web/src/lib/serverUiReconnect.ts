const RECONNECT_RETRY_MS = 1_000;
const RECONNECT_MAX_WAIT_MS = 120_000;
const SESSION_TIMEOUT_MS = 5_000;
const RELOAD_BACKOFF_MS = [0, 2_000, 5_000] as const;
const MAX_RELOADS = 3;
const ATTEMPTS_KEY = "t3code:server-ui-reconnect-attempts";
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

/** React replaces the boot shell when it mounts; losing it means the app owns the page. */
function isReactMounted(): boolean {
  return typeof document === "undefined" || document.getElementById("boot-shell") === null;
}

let overlay: HTMLElement | null = null;

/** After mount the app owns the page: offer the fallback without touching its tree. */
function showReconnectOverlay(): void {
  if (typeof document === "undefined" || overlay !== null) return;
  overlay = document.createElement("div");
  overlay.id = "server-ui-reconnect-overlay";
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.style.cssText =
    "position:fixed;right:20px;bottom:20px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;max-width:340px;padding:14px 16px;border:1px solid #444;border-radius:12px;background:#181818;color:#eee;font:14px system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.45)";
  const title = document.createElement("strong");
  title.textContent = `Reconnecting to ${serverUiLabel()}…`;
  const detail = document.createElement("span");
  detail.textContent = "The server is restarting. Reload this page when it is back.";
  detail.style.cssText = "color:#aaa;line-height:1.5";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
  const fallback = document.createElement("button");
  fallback.type = "button";
  fallback.textContent = "Use the built-in version";
  fallback.title = "Works offline with your saved connections";
  fallback.style.cssText =
    "padding:6px 10px;border-radius:8px;border:1px solid #555;background:transparent;color:#eee;font:inherit;cursor:pointer";
  fallback.addEventListener("click", () => window.desktopShell?.returnToBundled());
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload page";
  reload.style.cssText =
    "padding:6px 10px;border-radius:8px;border:1px solid #555;background:transparent;color:#eee;font:inherit;cursor:pointer";
  reload.addEventListener("click", () => window.location.reload());
  actions.append(fallback, reload);
  overlay.append(title, detail, actions);
  document.body.append(overlay);
}

function installReconnectingSurface(): boolean {
  const host = document.getElementById("boot-shell");
  if (host === null) return false;
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
  return true;
}

export type ReconnectProbe = "ready" | "rejected" | "unavailable";

export interface ReconnectAttemptStore {
  read(): number;
  write(count: number): void;
  clear(): void;
}

export interface ReconnectLoopHooks {
  readonly probe: () => Promise<ReconnectProbe>;
  readonly beforeReload: () => Promise<void>;
  readonly reload: () => void;
  readonly fallback: () => void;
  readonly attempts: ReconnectAttemptStore;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly now: () => number;
}

export function memoryReconnectAttempts(initial = 0): ReconnectAttemptStore {
  let count = initial;
  return {
    read: () => count,
    write: (next) => {
      count = next;
    },
    clear: () => {
      count = 0;
    },
  };
}

/** Bounded reloads with backoff; the counter survives reloads in sessionStorage. */
export async function runServerUiReconnect(hooks: ReconnectLoopHooks): Promise<void> {
  const startedAt = hooks.now();
  let attempt = hooks.attempts.read();
  while (hooks.now() - startedAt < RECONNECT_MAX_WAIT_MS) {
    const state = await hooks.probe();
    if (state === "ready") {
      if (attempt >= MAX_RELOADS) {
        hooks.attempts.clear();
        hooks.fallback();
        return;
      }
      const backoff = RELOAD_BACKOFF_MS[attempt] ?? 0;
      attempt += 1;
      hooks.attempts.write(attempt);
      if (backoff > 0) await hooks.sleep(backoff);
      await hooks.beforeReload();
      hooks.reload();
      return;
    }
    if (state === "rejected") {
      hooks.attempts.clear();
      hooks.fallback();
      return;
    }
    await hooks.sleep(RECONNECT_RETRY_MS);
  }
  hooks.attempts.clear();
  hooks.fallback();
}

function sessionStorageAttempts(): ReconnectAttemptStore {
  const read = (): number => {
    try {
      const raw = sessionStorage.getItem(ATTEMPTS_KEY);
      const value = raw === null ? 0 : Number(raw);
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    } catch {
      return 0;
    }
  };
  return {
    read,
    write: (count) => {
      try {
        sessionStorage.setItem(ATTEMPTS_KEY, String(count));
      } catch {
        // A blocked storage must not break recovery.
      }
    },
    clear: () => {
      try {
        sessionStorage.removeItem(ATTEMPTS_KEY);
      } catch {
        // A blocked storage must not break recovery.
      }
    },
  };
}

function clearServerUiReconnectAttempts(): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorageAttempts().clear();
}

/** Clear the reload budget only after the app has mounted and stayed healthy. */
export const HEALTHY_RESET_MS = 10_000;

export function reconnectBudgetMayReset(mountedForMs: number): boolean {
  return mountedForMs >= HEALTHY_RESET_MS;
}

export function installHealthyReconnectReset(): void {
  if (!isServerUiWindow()) return;
  let mountedForMs = 0;
  const timer = setInterval(() => {
    if (!isReactMounted()) {
      mountedForMs = 0;
      return;
    }
    mountedForMs += 1_000;
    if (reconnectBudgetMayReset(mountedForMs)) {
      clearInterval(timer);
      clearServerUiReconnectAttempts();
    }
  }, 1_000);
}

async function probeSession(): Promise<ReconnectProbe> {
  try {
    const requestToken = window.desktopShell?.requestToken;
    const response = await fetch(SESSION_PATH, {
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(requestToken ? { "x-t3-server-ui": requestToken } : {}),
      },
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
    if (!response.ok) return "unavailable";
    const body: unknown = await response.json().catch(() => null);
    if (
      typeof body === "object" &&
      body !== null &&
      "authenticated" in body &&
      body.authenticated === false
    ) {
      return "rejected";
    }
    return "ready";
  } catch {
    return "unavailable";
  }
}

async function beforeReload(): Promise<void> {
  try {
    const [sends, drafts] = await Promise.all([
      import("../components/chat/draftSendState"),
      import("../composerDraftStore"),
    ]);
    await new Promise<void>((resolve) => {
      sends.afterChatSendsSettled(() => {
        drafts.flushComposerDrafts();
        resolve();
      });
    });
  } catch (error) {
    console.warn("Could not wait for pending sends before reloading the server UI.", error);
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

let reconnecting = false;

/** Waits for the server after a chunk failure, then reloads, or falls back to bundled UI. */
export async function beginServerUiReconnect(): Promise<void> {
  if (reconnecting || !isServerUiWindow()) return;
  if (isReactMounted()) {
    showReconnectOverlay();
    return;
  }
  reconnecting = true;
  if (!installReconnectingSurface()) return;
  await runServerUiReconnect({
    probe: probeSession,
    beforeReload,
    reload: () => window.location.reload(),
    fallback: () => window.desktopShell?.returnToBundled(),
    attempts: sessionStorageAttempts(),
    sleep: wait,
    now: () => Date.now(),
  });
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
