import * as NodeTimersPromises from "node:timers/promises";
const { setTimeout } = NodeTimersPromises;

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
  observers = [],
) {
  const deadline = clock.now() + maxWaitMs;
  for (;;) {
    try {
      const actual = await adapter.health();
      for (const baseline of baselines) assertHealth(actual, version, baseline);
      for (const other of await Promise.all(
        observers.filter((observer) => observer !== adapter).map((observer) => observer.health()),
      )) {
        if (!other.replicasReady) throw new Error("Peer replicas have not resumed");
        assertHealth(actual, version, other);
        for (const [key, value] of Object.entries(actual.entries)) {
          if ((other.entries[key] ?? "") < value)
            throw new Error(`Peer layout has not converged: ${key}`);
        }
      }
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
    await journal({ machine: adapter.name, phase: "prepare" });
    await adapter.prepare();
    try {
      await journal({ machine: adapter.name, phase: "drain" });
      await adapter.drain();
      await journal({ machine: adapter.name, phase: "switch" });
      await adapter.activate();
      await waitForHealthy(adapter, version, baselines, options.healthWaitMs, clock, adapters);
      await journal({ machine: adapter.name, phase: "healthy" });
      if (adapter.commit) await adapter.commit();
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
          adapters,
        );
        if (adapter.release) await adapter.release();
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
