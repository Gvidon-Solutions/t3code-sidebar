import {
  MeshConfigError,
  type MeshConfigRevision,
  type MeshConfigAction,
} from "@t3tools/contracts";
import { configYaml, parseConfig, referenceErrors } from "@t3tools/shared/meshConfig";
import * as Schema from "effect/Schema";

const isConfigError = Schema.is(MeshConfigError);
export type ConfigEditorState = {
  text: string;
  base: MeshConfigRevision | null;
  actions: readonly MeshConfigAction[] | null;
  error: string | null;
  stale: MeshConfigError | null;
  busy: boolean;
};

type ConfigRpc = {
  get: () => Promise<{ current: MeshConfigRevision | null }>;
  plan: (doc: unknown) => Promise<{ actions: readonly MeshConfigAction[] }>;
  apply: (doc: unknown, baseRevision: string | null) => Promise<MeshConfigRevision>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function rebaseDoc(base: unknown, desired: unknown, current: unknown): unknown {
  if (JSON.stringify(base) === JSON.stringify(desired)) return current;
  if (!record(base) || !record(desired)) return desired;
  const result = record(current) ? { ...current } : {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(desired)])) {
    if (!Object.hasOwn(desired, key)) delete result[key];
    else if (!Object.hasOwn(base, key)) result[key] = desired[key];
    else result[key] = rebaseDoc(base[key], desired[key], result[key]);
  }
  return result;
}
export class MeshConfigEditor {
  private state: ConfigEditorState = {
    text: "",
    base: null,
    actions: null,
    error: null,
    stale: null,
    busy: false,
  };
  private listeners = new Set<() => void>();
  private readonly rpc: ConfigRpc;
  constructor(rpc: ConfigRpc) {
    this.rpc = rpc;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<ConfigEditorState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  edit = (text: string) => this.set({ text, actions: null, error: null, stale: null });
  private async run(operation: () => Promise<void>) {
    if (this.state.busy) return;
    this.set({ busy: true, error: null });
    try {
      await operation();
    } catch (error) {
      this.set({
        error: error instanceof Error ? error.message : String(error),
        stale: isConfigError(error) && error.reason === "stale_revision" ? error : null,
      });
    } finally {
      this.set({ busy: false });
    }
  }
  load = () =>
    this.run(async () => {
      const { current } = await this.rpc.get();
      this.set({
        base: current,
        text: configYaml(current?.doc ?? { schema: 1, machines: {} }),
        actions: null,
        stale: null,
      });
    });
  restore = (revision: MeshConfigRevision) => this.edit(configYaml(revision.doc));
  plan = () =>
    this.run(async () => {
      const doc = parseConfig(this.state.text);
      const errors = referenceErrors(doc);
      if (errors.length)
        throw new Error(errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
      const plan = await this.rpc.plan(doc);
      this.set({ actions: plan.actions });
    });
  apply = () =>
    this.run(async () => {
      if (this.state.actions === null)
        throw new Error("Plan the configuration before applying it.");
      const revision = await this.rpc.apply(
        parseConfig(this.state.text),
        this.state.base?.revision ?? null,
      );
      this.set({ base: revision, text: configYaml(revision.doc), actions: null, stale: null });
    });
  rebase = () =>
    this.run(async () => {
      const desired = parseConfig(this.state.text);
      const { current } = await this.rpc.get();
      const rebased = rebaseDoc(
        this.state.base?.doc ?? { schema: 1, machines: {} },
        desired,
        current?.doc ?? { schema: 1, machines: {} },
      );
      this.set({ base: current, text: configYaml(rebased), actions: null, stale: null });
    });
}
