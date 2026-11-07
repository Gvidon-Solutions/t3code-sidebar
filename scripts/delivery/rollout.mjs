import * as NodeTimersPromises from "node:timers/promises";
const { setTimeout } = NodeTimersPromises;

export async function waitForIdle(
  adapter,
  { now = false, maxWaitMs, intervalMs = 1000 },
  clock = { now: Date.now, sleep: setTimeout },
) {
  if (now) return;
  const deadline = clock.now() + maxWaitMs;
  while (await adapter.busy()) {
    if (clock.now() >= deadline) throw new Error("Idle window deadline exceeded; nothing switched");
    await clock.sleep(Math.min(intervalMs, deadline - clock.now()));
  }
}

export function assertHealth(actual, expectedVersion, baseline) {
  if (actual.version !== expectedVersion) throw new Error(`Version mismatch: ${actual.version}`);
  if (!actual.replicasReady) throw new Error("Replicas have not resumed");
  if (actual.revision !== baseline.revision)
    throw new Error("Mesh config revision changed during delivery");
  for (const [key, value] of Object.entries(baseline.entries)) {
    if ((actual.entries[key] ?? "") < value) throw new Error(`Layout has not converged: ${key}`);
  }
}

export async function waitForHealthy(
  adapter,
  version,
  baselines,
  maxWaitMs,
  clock = { now: Date.now, sleep: setTimeout },
) {
  const deadline = clock.now() + maxWaitMs;
  for (;;) {
    try {
      const actual = await adapter.health();
      for (const baseline of baselines) assertHealth(actual, version, baseline);
      return;
    } catch (error) {
      if (clock.now() >= deadline) throw error;
      await clock.sleep(Math.min(1000, deadline - clock.now()));
    }
  }
}

export async function rollout(
  adapters,
  version,
  options,
  journal,
  clock = { now: Date.now, sleep: setTimeout },
) {
  const baselines = await Promise.all(adapters.map((adapter) => adapter.health()));
  for (const baseline of baselines) {
    if (baseline.desiredVersion && baseline.desiredVersion !== version)
      throw new Error(
        `Managed mesh version ${baseline.desiredVersion} conflicts with delivery ${version}`,
      );
  }
  for (let i = 0; i < adapters.length; i++) {
    const adapter = adapters[i];
    await waitForIdle(adapter, options, clock);
    await journal({ machine: adapter.name, phase: "prepare" });
    await adapter.prepare();
    try {
      await journal({ machine: adapter.name, phase: "switch" });
      await adapter.activate();
      await waitForHealthy(adapter, version, baselines, options.healthWaitMs, clock);
      await journal({ machine: adapter.name, phase: "healthy" });
    } catch (error) {
      await journal({ machine: adapter.name, phase: "rollback", reason: error.message });
      try {
        await adapter.rollback();
        await waitForHealthy(
          adapter,
          baselines[i].version,
          [baselines[i]],
          options.healthWaitMs,
          clock,
        );
      } catch (rollbackError) {
        throw new Error(
          `${adapter.name}: rollout failed (${error.message}); rollback failed (${rollbackError.message})`,
          {
            cause: rollbackError,
          },
        );
      }
      throw new Error(`${adapter.name}: rolled back; rollout stopped: ${error.message}`, {
        cause: error,
      });
    }
  }
}
