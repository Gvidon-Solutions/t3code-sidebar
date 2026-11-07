import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Kit from "./MeshAgentKit.ts";

it.effect(
  "installs skills and creates managed instructions in an isolated home; updates preserve surrounding text",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "b1-agent-home-" });
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
        Effect.provide(Kit.layer),
        Effect.provideService(HostProcess.Environment, {
          T3_MESH_AGENT_HOME: home,
          T3_MESH_AGENT_SOURCE: source,
        }),
      );
      const doc = {
        schema: 1,
        machines: { laptop: { label: "LT" }, studio: { label: "ST" } },
        agents: { instructions: "Shared instructions" },
      };
      yield* kit.reconcile(doc);
      expect(yield* fs.exists(`${home}/.agents/skills/t3/global`)).toBe(false);
      expect(yield* fs.exists(`${home}/.agents/skills/t3/scripts/tool.test.mjs`)).toBe(false);
      const first = yield* fs.readFileString(`${home}/.codex/AGENTS.md`);
      expect(first.startsWith(original)).toBe(true);
      expect(first).toContain("laptop (LT), studio (ST)");
      expect(first).toContain("Shared instructions");
      for (const directory of [".agents", ".claude", ".codex", ".config/opencode"]) {
        expect(yield* fs.readFileString(`${home}/${directory}/skills/t3/SKILL.md`)).toBe(
          "skill v1",
        );
      }
      expect(yield* fs.exists(`${home}/.claude/CLAUDE.md`)).toBe(true);
      expect(yield* fs.exists(`${home}/.config/opencode/AGENTS.md`)).toBe(true);
      yield* kit.reconcile(doc);
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
      yield* fs.writeFileString(`${home}/.claude/CLAUDE.md`, "<!-- t3-mesh begin -->broken");
      const failure = yield* kit.reconcile(doc).pipe(Effect.flip);
      expect(failure.reason).toBe("validation");
      expect(failure.message).toContain(".claude/CLAUDE.md");
      expect(yield* fs.readFileString(`${home}/.codex/AGENTS.md`)).toBe(updated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

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
