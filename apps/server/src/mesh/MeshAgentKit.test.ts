import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Kit from "./MeshAgentKit.ts";
import * as Settings from "../serverSettings.ts";

const codexInstance = (binaryPath: string) => ({
  [ProviderInstanceId.make("codex")]: {
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    config: { binaryPath },
  },
});

it.effect(
  "installs skills and creates managed instructions in an isolated home; updates preserve surrounding text",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "mesh-agent-home-" });
      const source = `${home}/bundled`;
      yield* fs.makeDirectory(`${source}/scripts`, { recursive: true });
      yield* fs.writeFileString(`${source}/SKILL.md`, "skill v1");
      yield* fs.makeDirectory(`${source}/global`);
      yield* fs.writeFileString(`${source}/global/GLOBAL.md`, "Legacy private text");
      yield* fs.writeFileString(`${source}/scripts/tool.test.mjs`, "test only");
      yield* fs.writeFileString(`${source}/scripts/t3ctl.mjs`, "export {};");
      yield* fs.makeDirectory(`${home}/.codex`, { recursive: true });
      const original = "Owner text\r\n";
      yield* fs.writeFileString(`${home}/.codex/AGENTS.md`, original);
      const kit = yield* Kit.MeshAgentKit.pipe(
        Effect.provide(Kit.layer.pipe(Layer.provide(Settings.layerTest()))),
        Effect.provideService(HostProcess.Environment, {
          T3_MESH_AGENT_HOME: home,
          T3_MESH_AGENT_SOURCE: source,
        }),
        Effect.provideService(SpawnExecutableResolution, (command) =>
          ["claude", "codex", "opencode"].includes(command)
            ? `/usr/local/bin/${command}`
            : undefined,
        ),
      );
      const doc = {
        schema: 1,
        machines: { laptop: { label: "LT" }, studio: { label: "ST" } },
        agents: { instructions: "Shared instructions" },
      };
      yield* kit.reconcile(doc, { title: "Studio", label: "ST" });
      expect(yield* fs.exists(`${home}/.agents/skills/t3/global`)).toBe(false);
      expect(yield* fs.exists(`${home}/.agents/skills/t3/scripts/tool.test.mjs`)).toBe(false);
      const first = yield* fs.readFileString(`${home}/.codex/AGENTS.md`);
      expect(first.startsWith(original)).toBe(true);
      expect(first).toContain("<!-- t3-mesh begin -->\nThis machine: Studio (ST).");
      expect(first).toContain("laptop (LT), studio (ST)");
      expect(first).toContain("Shared instructions");
      for (const directory of [".agents", ".claude", ".codex", ".config/opencode"]) {
        expect(yield* fs.readFileString(`${home}/${directory}/skills/t3/SKILL.md`)).toBe(
          "skill v1",
        );
      }
      expect(yield* fs.exists(`${home}/.claude/CLAUDE.md`)).toBe(true);
      expect(yield* fs.exists(`${home}/.config/opencode/AGENTS.md`)).toBe(true);
      yield* kit.reconcile(doc, { title: "Studio", label: "ST" });
      expect(yield* fs.readFileString(`${home}/.codex/AGENTS.md`)).toBe(first);
      yield* fs.writeFileString(`${home}/.codex/AGENTS.md`, `${first}After block\n`);
      yield* fs.writeFileString(`${source}/SKILL.md`, "skill v2");
      yield* kit.reconcile({ ...doc, agents: { instructions: "New instructions" } });
      const updated = yield* fs.readFileString(`${home}/.codex/AGENTS.md`);
      expect(updated.startsWith(original)).toBe(true);
      expect(updated.endsWith("After block\n")).toBe(true);
      expect(updated).not.toContain("Shared instructions");
      expect(updated).toContain("New instructions");
      expect(yield* fs.readFileString(`${home}/.agents/skills/t3/SKILL.md`)).toBe("skill v2");
      yield* kit.reconcile({ ...doc, agents: { manageInstructions: false } });
      expect(yield* fs.readFileString(`${home}/.codex/AGENTS.md`)).toBe(updated);
      yield* fs.makeDirectory(`${home}/.claude`, { recursive: true });
      yield* fs.writeFileString(`${home}/.claude/CLAUDE.md`, "<!-- t3-mesh begin -->broken");
      const failure = yield* kit.reconcile(doc).pipe(Effect.flip);
      expect(failure.reason).toBe("validation");
      expect(failure.message).toContain(".claude/CLAUDE.md");
      expect(yield* fs.readFileString(`${home}/.codex/AGENTS.md`)).toBe(updated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps a harness home and a configured provider binary installed without a PATH hit",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "agent-harness-" });
      const source = `${home}/bundled`;
      yield* fs.makeDirectory(`${source}/scripts`, { recursive: true });
      yield* fs.writeFileString(`${source}/SKILL.md`, "skill v1");
      yield* fs.writeFileString(`${source}/scripts/t3ctl.mjs`, "export {};");
      // Claude is installed through its home directory, even with no binary on PATH.
      yield* fs.makeDirectory(`${home}/.claude/skills/t3`, { recursive: true });
      yield* fs.writeFileString(`${home}/.claude/skills/t3/SKILL.md`, "old skill");
      const previous =
        "Owner note\n\n<!-- t3-mesh begin -->\nold block\n<!-- t3-mesh end -->\n\nTail\n";
      yield* fs.writeFileString(`${home}/.claude/CLAUDE.md`, previous);
      // Codex is installed through an absolute provider binary, without its own home.
      const codex = `${home}/bin/codex`;
      yield* fs.makeDirectory(`${home}/bin`, { recursive: true });
      yield* fs.writeFileString(codex, "#!/bin/sh\n");
      const kit = yield* Kit.MeshAgentKit.pipe(
        Effect.provide(
          Kit.layer.pipe(
            Layer.provide(
              Settings.layerTest({
                providerInstances: {
                  ...codexInstance(codex),
                },
              }),
            ),
          ),
        ),
        Effect.provideService(HostProcess.Environment, {
          T3_MESH_AGENT_HOME: home,
          T3_MESH_AGENT_SOURCE: source,
        }),
        Effect.provideService(SpawnExecutableResolution, () => undefined),
      );
      yield* kit.reconcile({ schema: 1, machines: { studio: { label: "ST" } } });
      // Both detected harnesses receive the skill; Claude's owner text and our block stay.
      expect(yield* fs.readFileString(`${home}/.codex/skills/t3/SKILL.md`)).toBe("skill v1");
      expect(yield* fs.readFileString(`${home}/.claude/skills/t3/SKILL.md`)).toBe("skill v1");
      const claudeInstructions = yield* fs.readFileString(`${home}/.claude/CLAUDE.md`);
      expect(claudeInstructions.startsWith("Owner note\n\n<!-- t3-mesh begin -->")).toBe(true);
      expect(claudeInstructions.endsWith("\n\nTail\n")).toBe(true);
      // OpenCode is positively absent: nothing of ours is created there.
      expect(yield* fs.exists(`${home}/.config/opencode/skills/t3`)).toBe(false);
      expect(yield* fs.exists(`${home}/.config/opencode/AGENTS.md`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not treat a configured provider binary that is missing on disk as installed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "agent-missing-binary-" });
    const source = `${home}/bundled`;
    yield* fs.makeDirectory(`${source}/scripts`, { recursive: true });
    yield* fs.writeFileString(`${source}/SKILL.md`, "skill v1");
    yield* fs.writeFileString(`${source}/scripts/t3ctl.mjs`, "export {};");
    const kit = yield* Kit.MeshAgentKit.pipe(
      Effect.provide(
        Kit.layer.pipe(
          Layer.provide(
            Settings.layerTest({
              providerInstances: { ...codexInstance(`${home}/missing/codex`) },
            }),
          ),
        ),
      ),
      Effect.provideService(HostProcess.Environment, {
        T3_MESH_AGENT_HOME: home,
        T3_MESH_AGENT_SOURCE: source,
      }),
      Effect.provideService(SpawnExecutableResolution, () => undefined),
    );
    yield* kit.reconcile({ schema: 1, machines: { studio: { label: "ST" } } });
    expect(yield* fs.exists(`${home}/.codex/skills/t3`)).toBe(false);
    expect(yield* fs.exists(`${home}/.codex/AGENTS.md`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("removes only the managed block and never trims surrounding text", () => {
  const original = "keep  \n<!-- t3-mesh begin -->\nbody\n<!-- t3-mesh end -->\n\n  after";
  expect(Kit.withoutManagedBlock(original)).toBe("keep  \n\n\n  after");
  expect(Kit.withoutManagedBlock("<!-- t3-mesh begin -->\nbody\n<!-- t3-mesh end -->\n")).toBe("");
});

it("rejects ambiguous managed blocks without truncating user content", () => {
  expect(() => Kit.instructionBlock("Owner text", "<!-- t3-mesh begin -->")).toThrow(
    "reserved markers",
  );
  for (const text of [
    "<!-- t3-mesh end -->",
    "<!-- t3-mesh end --><!-- t3-mesh begin -->",
    "<!-- t3-mesh begin --><!-- t3-mesh begin --><!-- t3-mesh end -->",
  ]) {
    expect(() => Kit.instructionBlock(text, "body")).toThrow("Malformed");
  }
  expect(
    Kit.instructionBlock("prefix<!-- t3-mesh begin -->old<!-- t3-mesh end -->suffix", "new"),
  ).toBe("prefix<!-- t3-mesh begin -->\nnew\n<!-- t3-mesh end -->suffix");
});

it("replaces the retired installer's copy of the shared instructions instead of duplicating it", () => {
  const shared = "# Как мы работаем\n\nПравила.\n";
  const installed = `> Эта машина — **Studio** (ST): соседние: laptop (LT).\n\n${shared}`;
  expect(Kit.withoutLegacyInstructions(installed, shared)).toBe("");
  const withOwnText = `My own note\n\n${installed}\nAfter\n`;
  expect(Kit.withoutLegacyInstructions(withOwnText, shared)).toBe("My own note\n\nAfter\n");
  expect(Kit.withoutLegacyInstructions("Unrelated text\n", shared)).toBe("Unrelated text\n");
  const blockFirst = Kit.instructionBlock(installed, "Mesh machines: studio (ST).");
  const cleaned = Kit.withoutLegacyInstructions(blockFirst, shared);
  expect(cleaned.startsWith("<!-- t3-mesh begin -->")).toBe(true);
  expect(Kit.instructionBlock(cleaned, `Mesh\n\n${shared}`).split("Правила.").length - 1).toBe(1);
  const managedWithCopy = Kit.instructionBlock("", shared);
  expect(Kit.withoutLegacyInstructions(managedWithCopy, shared)).toBe(managedWithCopy);
  expect(Kit.withoutLegacyInstructions(installed, undefined)).toBe(installed);
  const adopted = Kit.instructionBlock(Kit.withoutLegacyInstructions(installed, shared), shared);
  expect(adopted.split("Правила.").length - 1).toBe(1);
  expect(adopted.startsWith("<!-- t3-mesh begin -->")).toBe(true);
});

it("starts the managed body with the server's own bound identity", () => {
  const doc = {
    schema: 1,
    machines: {
      cloudbox: { title: "Cloudbox", label: "CB" },
      studio: { title: "Studio", label: "ST" },
    },
  };
  expect(Kit.meshInstructions(doc, { title: "Studio", label: "ST" })).toMatch(
    /^This machine: Studio \(ST\)\./,
  );
  expect(Kit.meshInstructions(doc, { title: "Cloudbox", label: "CB" })).toMatch(
    /^This machine: Cloudbox \(CB\)\./,
  );
});
