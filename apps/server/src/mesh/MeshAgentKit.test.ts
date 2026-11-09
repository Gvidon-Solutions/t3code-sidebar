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
      yield* fs.writeFileString(`${home}/.claude/skills/t3/.t3-managed`, "ours\n");
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

it("removes the retired installer's instructions only as a whole paragraph", () => {
  const shared = "# Team rules\n\nKeep every byte.\n";
  const installed = `> This machine is Studio\n\n${shared}`;
  expect(Kit.withoutLegacyInstructions(installed, shared)).toBe("> This machine is Studio\n");
  const withOwnText = `My own note\n\n${installed}\nAfter\n`;
  expect(Kit.withoutLegacyInstructions(withOwnText, shared)).toBe(
    "My own note\n\n> This machine is Studio\n\nAfter\n",
  );
  expect(Kit.withoutLegacyInstructions("Unrelated text\n", shared)).toBe("Unrelated text\n");
  const midLine = `Owner text mentions ${shared.trim()} in one line\n`;
  expect(Kit.withoutLegacyInstructions(midLine, shared)).toBe(midLine);
  const inlineParagraph = `Before ${shared.trim()} after\n\nTail\n`;
  expect(Kit.withoutLegacyInstructions(inlineParagraph, shared)).toBe(inlineParagraph);
  const unrelatedQuote = `> An unrelated quote\n\n${shared}`;
  expect(Kit.withoutLegacyInstructions(unrelatedQuote, shared)).toBe("> An unrelated quote\n");
  const quoteWithoutSeparator = `> An unrelated quote\n${shared}`;
  expect(Kit.withoutLegacyInstructions(quoteWithoutSeparator, shared)).toBe(quoteWithoutSeparator);
  const managedWithCopy = Kit.instructionBlock("", shared);
  expect(Kit.withoutLegacyInstructions(managedWithCopy, shared)).toBe(managedWithCopy);
  expect(Kit.withoutLegacyInstructions(`${shared}Tail`, shared)).toBe(`${shared}Tail`);
  expect(Kit.withoutLegacyInstructions(installed, undefined)).toBe(installed);
  const adopted = Kit.instructionBlock(Kit.withoutLegacyInstructions(installed, shared), shared);
  expect(adopted.split("Keep every byte.").length - 1).toBe(1);
  expect(adopted).toContain("<!-- t3-mesh begin -->");
  expect(adopted).toContain("> This machine is Studio");
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

const reconcileWith = (home: string, source: string) =>
  Kit.MeshAgentKit.pipe(
    Effect.provide(Kit.layer.pipe(Layer.provide(Settings.layerTest()))),
    Effect.provideService(HostProcess.Environment, {
      T3_MESH_AGENT_HOME: home,
      T3_MESH_AGENT_SOURCE: source,
    }),
    Effect.provideService(SpawnExecutableResolution, () => undefined),
  );

const bundledSkill = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = `${home}/bundled`;
    yield* fs.makeDirectory(`${source}/scripts`, { recursive: true });
    yield* fs.writeFileString(`${source}/SKILL.md`, "skill v1");
    yield* fs.writeFileString(`${source}/scripts/t3ctl.mjs`, "export {};");
    return source;
  });

it.effect("never replaces a skill directory it does not own and reports it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "agent-unmanaged-skill-" });
    const source = yield* bundledSkill(home);
    yield* fs.makeDirectory(`${home}/.claude/skills/t3`, { recursive: true });
    yield* fs.writeFileString(`${home}/.claude/skills/t3/SKILL.md`, "user skill");
    const kit = yield* reconcileWith(home, source);
    const failure = yield* kit.reconcile({ schema: 1, machines: {} }).pipe(Effect.flip);
    expect(failure.reason).toBe("validation");
    expect(failure.message).toContain(".claude/skills/t3");
    expect(yield* fs.readFileString(`${home}/.claude/skills/t3/SKILL.md`)).toBe("user skill");
    expect(yield* fs.exists(`${home}/.claude/skills/t3/.t3-managed`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("removes only files named by the previous manifest and keeps unknown files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "agent-managed-skill-" });
    const source = yield* bundledSkill(home);
    yield* fs.makeDirectory(`${home}/.claude/skills/t3/old`, { recursive: true });
    yield* fs.writeFileString(
      `${home}/.claude/skills/t3/.t3-managed`,
      JSON.stringify({ files: ["SKILL.md", "scripts/t3ctl.mjs", "stale.txt", "old/stale.txt"] }),
    );
    yield* fs.writeFileString(`${home}/.claude/skills/t3/SKILL.md`, "old skill");
    yield* fs.writeFileString(`${home}/.claude/skills/t3/stale.txt`, "stale");
    yield* fs.writeFileString(`${home}/.claude/skills/t3/old/stale.txt`, "stale");
    yield* fs.writeFileString(`${home}/.claude/skills/t3/user-notes.txt`, "mine");
    const kit = yield* reconcileWith(home, source);
    yield* kit.reconcile({ schema: 1, machines: {} });
    expect(yield* fs.readFileString(`${home}/.claude/skills/t3/SKILL.md`)).toBe("skill v1");
    expect(yield* fs.readFileString(`${home}/.claude/skills/t3/scripts/t3ctl.mjs`)).toBe(
      "export {};",
    );
    expect(yield* fs.exists(`${home}/.claude/skills/t3/stale.txt`)).toBe(false);
    expect(yield* fs.exists(`${home}/.claude/skills/t3/old`)).toBe(false);
    expect(yield* fs.readFileString(`${home}/.claude/skills/t3/user-notes.txt`)).toBe("mine");
    expect(
      Kit.skillManifestFiles(yield* fs.readFileString(`${home}/.claude/skills/t3/.t3-managed`)),
    ).toEqual(["SKILL.md", "scripts/t3ctl.mjs"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves a symlinked skill directory alone and reports it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "agent-symlink-skill-" });
    const source = yield* bundledSkill(home);
    const real = `${home}/real-skill`;
    yield* fs.makeDirectory(real, { recursive: true });
    yield* fs.writeFileString(`${real}/SKILL.md`, "linked user skill");
    yield* fs.makeDirectory(`${home}/.claude/skills`, { recursive: true });
    yield* fs.symlink(real, `${home}/.claude/skills/t3`);
    const kit = yield* reconcileWith(home, source);
    const failure = yield* kit.reconcile({ schema: 1, machines: {} }).pipe(Effect.flip);
    expect(failure.reason).toBe("validation");
    expect(failure.message).toContain(".claude/skills/t3");
    expect(yield* fs.readFileString(`${real}/SKILL.md`)).toBe("linked user skill");
    expect(yield* fs.readLink(`${home}/.claude/skills/t3`)).toBe(real);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("never writes through a symlinked instruction file and reports it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "agent-symlink-instructions-" });
    const source = yield* bundledSkill(home);
    const target = `${home}/owner-instructions.md`;
    yield* fs.writeFileString(target, "owner text");
    yield* fs.makeDirectory(`${home}/.claude`, { recursive: true });
    yield* fs.symlink(target, `${home}/.claude/CLAUDE.md`);
    const kit = yield* reconcileWith(home, source);
    const failure = yield* kit.reconcile({ schema: 1, machines: {} }).pipe(Effect.flip);
    expect(failure.reason).toBe("validation");
    expect(failure.message).toContain(".claude/CLAUDE.md");
    expect(yield* fs.readFileString(target)).toBe("owner text");
    expect(yield* fs.readLink(`${home}/.claude/CLAUDE.md`)).toBe(target);
    // The skill is still installed; only the symlink is left alone.
    expect(yield* fs.readFileString(`${home}/.claude/skills/t3/SKILL.md`)).toBe("skill v1");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("adopts the retired kit, backs it up, keeps every unknown file and syncs ours", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "agent-adopt-" });
    const source = `${home}/bundled`;
    yield* fs.makeDirectory(`${source}/scripts`, { recursive: true });
    yield* fs.writeFileString(
      `${source}/SKILL.md`,
      "---\nname: t3\ndescription: bundle\n---\n\nnew body\n",
    );
    yield* fs.writeFileString(`${source}/scripts/t3ctl.mjs`, "export {};");
    yield* fs.writeFileString(`${source}/scripts/dropped.mjs`, "shipped once");
    const target = `${home}/.codex/skills/t3`;
    yield* fs.makeDirectory(`${target}/scripts`, { recursive: true });
    yield* fs.makeDirectory(`${target}/global`, { recursive: true });
    yield* fs.makeDirectory(`${target}/agents`, { recursive: true });
    yield* fs.writeFileString(
      `${target}/SKILL.md`,
      "---\nname: t3\ndescription: old\n---\n\nold body\n",
    );
    yield* fs.writeFileString(`${target}/scripts/t3ctl.mjs`, "old control");
    yield* fs.writeFileString(`${target}/global/GLOBAL.md`, "legacy owner instructions");
    yield* fs.writeFileString(`${target}/global/machines.json`, "{}");
    yield* fs.writeFileString(`${target}/agents/custom.md`, "custom agent");
    yield* fs.writeFileString(`${target}/user-notes.txt`, "mine");
    const kit = yield* Kit.MeshAgentKit.pipe(
      Effect.provide(Kit.layer.pipe(Layer.provide(Settings.layerTest()))),
      Effect.provideService(HostProcess.Environment, {
        T3_MESH_AGENT_HOME: home,
        T3_MESH_AGENT_SOURCE: source,
      }),
      Effect.provideService(SpawnExecutableResolution, () => undefined),
    );
    yield* kit.reconcile({ schema: 1, machines: { studio: { label: "ST" } } });
    const backups = (yield* fs.readDirectory(`${home}/.codex/skills`)).filter((name) =>
      name.startsWith("t3.backup-"),
    );
    expect(backups).toHaveLength(1);
    const backup = `${home}/.codex/skills/${backups[0]}`;
    expect(yield* fs.readFileString(`${backup}/global/GLOBAL.md`)).toBe(
      "legacy owner instructions",
    );
    expect(yield* fs.readFileString(`${target}/SKILL.md`)).toContain("new body");
    expect(yield* fs.readFileString(`${target}/scripts/t3ctl.mjs`)).toBe("export {};");
    expect(yield* fs.readFileString(`${target}/global/GLOBAL.md`)).toBe(
      "legacy owner instructions",
    );
    expect(yield* fs.readFileString(`${target}/global/machines.json`)).toBe("{}");
    expect(yield* fs.readFileString(`${target}/agents/custom.md`)).toBe("custom agent");
    expect(yield* fs.readFileString(`${target}/user-notes.txt`)).toBe("mine");
    // A file we shipped before and no longer ship is the only thing a later sync removes.
    yield* fs.remove(`${source}/scripts/dropped.mjs`);
    yield* kit.reconcile({ schema: 1, machines: { studio: { label: "ST" } } });
    expect(yield* fs.exists(`${target}/scripts/dropped.mjs`)).toBe(false);
    expect(yield* fs.readFileString(`${target}/user-notes.txt`)).toBe("mine");
    expect(yield* fs.readFileString(`${target}/global/GLOBAL.md`)).toBe(
      "legacy owner instructions",
    );
    const afterSecondSync = yield* fs.readDirectory(`${home}/.codex/skills`);
    expect(afterSecondSync.filter((name) => name.startsWith("t3.backup-"))).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses an unmarked skill directory that is not recognisably ours", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "agent-refuse-" });
    const source = `${home}/bundled`;
    yield* fs.makeDirectory(`${source}/scripts`, { recursive: true });
    yield* fs.writeFileString(`${source}/SKILL.md`, "---\nname: t3\n---\nnew\n");
    yield* fs.writeFileString(`${source}/scripts/t3ctl.mjs`, "export {};");
    // Our name, but not our layout: no scripts/t3ctl.mjs.
    yield* fs.makeDirectory(`${home}/.codex/skills/t3`, { recursive: true });
    yield* fs.writeFileString(
      `${home}/.codex/skills/t3/SKILL.md`,
      "---\nname: t3\ndescription: imported\n---\n\nowner body\n",
    );
    const kit = yield* Kit.MeshAgentKit.pipe(
      Effect.provide(Kit.layer.pipe(Layer.provide(Settings.layerTest()))),
      Effect.provideService(HostProcess.Environment, {
        T3_MESH_AGENT_HOME: home,
        T3_MESH_AGENT_SOURCE: source,
      }),
      Effect.provideService(SpawnExecutableResolution, () => undefined),
    );
    const failure = yield* kit.reconcile({ schema: 1, machines: {} }).pipe(Effect.flip);
    expect(failure.reason).toBe("validation");
    expect(failure.message).toContain("not a T3-managed t3 skill");
    expect(yield* fs.exists(`${home}/.codex/skills/t3/.t3-managed`)).toBe(false);
    expect(yield* fs.readFileString(`${home}/.codex/skills/t3/SKILL.md`)).toContain("owner body");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("recognises only a t3 frontmatter name", () => {
  expect(Kit.isRecognizablyT3Skill("---\nname: t3\ndescription: x\n---\nbody")).toBe(true);
  expect(Kit.isRecognizablyT3Skill("---\nname: 't3'\n---\nbody")).toBe(true);
  expect(Kit.isRecognizablyT3Skill("---\nname: other\n---\nbody")).toBe(false);
  expect(Kit.isRecognizablyT3Skill("no frontmatter name: t3")).toBe(false);
});
