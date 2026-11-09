import { describe, expect, it, vi } from "vite-plus/test";
import {
  isChunkLoadFailure,
  memoryReconnectAttempts,
  runServerUiReconnect,
  serverUiLabel,
  type ReconnectLoopHooks,
  type ReconnectProbe,
} from "./serverUiReconnect";

function loop(
  probes: ReadonlyArray<ReconnectProbe>,
  options: { readonly attempts?: number; readonly now?: () => number } = {},
) {
  const events: string[] = [];
  const sleeps: number[] = [];
  const attempts = memoryReconnectAttempts(options.attempts ?? 0);
  let index = 0;
  const hooks: ReconnectLoopHooks = {
    probe: async () => probes[Math.min(index++, probes.length - 1)] ?? "unavailable",
    beforeReload: async () => {
      events.push("before-reload");
    },
    reload: () => events.push("reload"),
    fallback: () => events.push("fallback"),
    attempts,
    sleep: async (delay) => {
      sleeps.push(delay);
    },
    now: options.now ?? (() => 0),
  };
  return { events, sleeps, attempts, hooks };
}

describe("isChunkLoadFailure", () => {
  it("recognizes the failures a server restart produces", () => {
    expect(
      isChunkLoadFailure(
        new TypeError("Failed to fetch dynamically imported module: /assets/a.js"),
      ),
    ).toBe(true);
    expect(isChunkLoadFailure(new Error("Unable to preload CSS for /assets/main-1.css"))).toBe(
      true,
    );
    expect(isChunkLoadFailure(new Error("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadFailure("Loading chunk 42 failed.")).toBe(true);
  });

  it("leaves ordinary errors to the boot error page", () => {
    expect(isChunkLoadFailure(new Error("Something else broke"))).toBe(false);
    expect(isChunkLoadFailure(undefined)).toBe(false);
  });

  it("uses the shell's machine name for the reconnecting message", () => {
    vi.stubGlobal("window", { desktopShell: { name: "Studio" } });
    expect(serverUiLabel()).toBe("Studio");
    vi.unstubAllGlobals();
  });
});

describe("runServerUiReconnect", () => {
  it("waits for pending sends before reloading", async () => {
    const { events, hooks, attempts } = loop(["ready"]);
    await runServerUiReconnect(hooks);
    expect(events).toEqual(["before-reload", "reload"]);
    expect(attempts.read()).toBe(1);
  });

  it("backs off and gives up after three reloads", async () => {
    const first = loop(["ready"]);
    await runServerUiReconnect(first.hooks);
    expect(first.sleeps).toEqual([]);

    const second = loop(["ready"], { attempts: 1 });
    await runServerUiReconnect(second.hooks);
    expect(second.sleeps).toEqual([2_000]);

    const third = loop(["ready"], { attempts: 2 });
    await runServerUiReconnect(third.hooks);
    expect(third.sleeps).toEqual([5_000]);

    const fourth = loop(["ready"], { attempts: 3 });
    await runServerUiReconnect(fourth.hooks);
    expect(fourth.events).toEqual(["fallback"]);
    expect(fourth.attempts.read()).toBe(0);
  });

  it("treats an unauthenticated session as rejected and falls back", async () => {
    const { events, hooks, attempts } = loop(["rejected"], { attempts: 2 });
    await runServerUiReconnect(hooks);
    expect(events).toEqual(["fallback"]);
    expect(attempts.read()).toBe(0);
  });

  it("retries an unreachable session until the deadline", async () => {
    let now = 0;
    const { events, hooks, sleeps } = loop(["unavailable", "unavailable", "ready"], {
      now: () => now,
    });
    const probe = hooks.probe;
    await runServerUiReconnect({
      ...hooks,
      probe: async () => {
        now += 1_000;
        return probe();
      },
    });
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(events).toEqual(["before-reload", "reload"]);
  });
});
