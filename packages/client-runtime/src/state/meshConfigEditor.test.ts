import { expect, it, vi } from "vite-plus/test";
import { MeshConfigError, type MeshConfigRevision } from "@t3tools/contracts";
import { MeshConfigEditor } from "./meshConfigEditor.ts";

const revision = (id: string, doc = { schema: 1, machines: {} }): MeshConfigRevision => ({
  revision: id,
  doc,
  author: "studio",
  writtenAt: "2026-11-05T00:00:00Z",
});
it("validates YAML and references, invalidates old plans and applies against the loaded revision", async () => {
  const apply = vi.fn(async () => revision("second"));
  const plan = vi.fn(async () => ({
    actions: [{ id: "ssh", server: "studio", description: "Update SSH" }],
  }));
  const editor = new MeshConfigEditor({
    get: async () => ({ current: revision("first") }),
    plan,
    apply,
  });
  await editor.load();
  editor.edit(
    "schema: 1\nmachines: {}\nreplicas:\n  rules: [{project: '*', on: missing, when: manual}]\n",
  );
  await editor.plan();
  expect(editor.getSnapshot().error).toContain("replicas.rules.0.on");
  expect(plan).not.toHaveBeenCalled();
  editor.edit("schema: 1\nmachines: {}\n");
  await editor.plan();
  expect(editor.getSnapshot().actions?.[0]?.description).toBe("Update SSH");
  editor.edit("schema: 1\nmachines: {}\n# edited\n");
  await editor.apply();
  expect(apply).not.toHaveBeenCalled();
  await editor.plan();
  await editor.apply();
  expect(apply).toHaveBeenCalledWith({ schema: 1, machines: {} }, "first");
  expect(editor.getSnapshot().base?.revision).toBe("second");
});
it("shows stale diffs, rebases edits onto the current config and restores history through plan/apply", async () => {
  let current = revision("first");
  const apply = vi.fn(async (_doc: unknown, base: string | null) => {
    if (base !== current.revision)
      throw new MeshConfigError({
        reason: "stale_revision",
        message: "Config changed",
        current,
        diff: [{ path: "$.t3.version", after: "next" }],
      });
    return current;
  });
  const editor = new MeshConfigEditor({
    get: async () => ({ current }),
    plan: async () => ({ actions: [] }),
    apply,
  });
  await editor.load();
  editor.edit("schema: 1\nmachines: {}\nagents:\n  instructions: hello\n");
  current = { ...revision("second"), doc: { schema: 1, machines: {}, t3: { version: "next" } } };
  await editor.plan();
  await editor.apply();
  expect(editor.getSnapshot().stale?.diff?.[0]?.path).toBe("$.t3.version");
  await editor.rebase();
  expect(editor.getSnapshot().text).toContain("version: next");
  expect(editor.getSnapshot().text).toContain("instructions: hello");
  expect(editor.getSnapshot().actions).toBeNull();
  await editor.plan();
  await editor.apply();
  expect(apply.mock.calls.at(-1)?.[1]).toBe("second");
  editor.restore(revision("first"));
  expect(editor.getSnapshot().base?.revision).toBe("second");
  expect(editor.getSnapshot().text).not.toContain("version");
});

it("does not enable Apply when the text changes during an outstanding plan", async () => {
  const pending = Promise.withResolvers<{ actions: [] }>();
  const apply = vi.fn(async () => revision("next"));
  const editor = new MeshConfigEditor({
    get: async () => ({ current: revision("base") }),
    plan: () => pending.promise,
    apply,
  });
  await editor.load();
  const planning = editor.plan();
  editor.edit("schema: 1\nmachines: {}\nssh: {mode: off}\n");
  pending.resolve({ actions: [] });
  await planning;
  expect(editor.getSnapshot().actions).toBeNull();
  await editor.apply();
  expect(apply).not.toHaveBeenCalled();
});
