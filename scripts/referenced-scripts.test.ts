// @effect-diagnostics nodeBuiltinImport:off -- Reads repository files without starting an Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "..");
const scriptExtensions = /\.(?:sh|mjs|cjs|ts|tsx|mts)$/;
const skippedDirectories = new Set(["node_modules", ".git", ".t3", "dist", "build", ".repos"]);

function walk(directory: string, result: string[] = []): string[] {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) walk(NodePath.join(directory, entry.name), result);
    } else {
      result.push(NodePath.join(directory, entry.name));
    }
  }
  return result;
}

const repositoryFiles = walk(root);
const relative = (file: string) => NodePath.relative(root, file);

it("references only existing script paths from shell and Node scripts", () => {
  const missing: string[] = [];
  const dynamic: string[] = [];
  const collect = (file: string, pattern: RegExp, base: string, prefix = "") => {
    const source = NodeFS.readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      const reference = `${prefix}${match[1]!.replace(/[.,)]+$/, "")}`;
      if (!scriptExtensions.test(reference)) continue;
      const where = `${relative(file)}: ${reference}`;
      if (reference.includes("$")) {
        dynamic.push(where);
        continue;
      }
      if (!NodeFS.existsSync(NodePath.resolve(base, reference))) missing.push(where);
    }
  };
  for (const file of repositoryFiles) {
    if (!/^scripts[\\/].*\.(?:sh|mjs|cjs)$/.test(relative(file))) continue;
    collect(file, /\$\{?MESH_DIR\}?\/([^\s"'`;:)]+)/g, NodePath.join(root, "scripts/mesh-e2e"));
    collect(file, /\$\{?REPO_ROOT\}?\/([^\s"'`;:)]+)/g, root);
    collect(
      file,
      /(?:^|[\s"'(])scripts\/([A-Za-z0-9_./-]+\.(?:sh|mjs|cjs|ts|tsx|mts))/g,
      root,
      "scripts/",
    );
  }
  expect(dynamic, "script paths must not be assembled from variables").toEqual([]);
  expect(missing, "referenced scripts must exist").toEqual([]);
});

it("references only existing entries in knip.jsonc", () => {
  const withoutComments = (source: string) => {
    let result = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < source.length; index++) {
      const character = source[index]!;
      if (inString) {
        result += character;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        result += character;
        continue;
      }
      if (character === "/" && source[index + 1] === "/") {
        while (index < source.length && source[index] !== "\n") index++;
        result += "\n";
        continue;
      }
      result += character;
    }
    return result;
  };
  const config = JSON.parse(
    withoutComments(NodeFS.readFileSync(NodePath.join(root, "knip.jsonc"), "utf8")).replace(
      /,\s*([\]}])/g,
      "$1",
    ),
  ) as { workspaces: Record<string, { entry?: string[] }> };
  const missing: string[] = [];
  for (const [workspace, value] of Object.entries(config.workspaces)) {
    const directory = workspace === "." ? root : NodePath.join(root, workspace);
    for (const entry of value.entry ?? []) {
      const path = entry.replace(/!$/, "");
      if (path.includes("*")) continue;
      if (!NodeFS.existsSync(NodePath.join(directory, path))) missing.push(`${workspace}: ${path}`);
    }
  }
  expect(missing).toEqual([]);
});

it("references only existing script paths from repository documents", () => {
  const documents = [
    "README.md",
    "FORK.md",
    "docs/mesh/README.md",
    "docs/sidebar-cross-device.md",
    "scripts/mesh-e2e/README.md",
    "scripts/mesh-fast/README.md",
  ];
  const files = repositoryFiles.map(relative);
  const missing: string[] = [];
  for (const document of documents) {
    const source = NodeFS.readFileSync(NodePath.join(root, document), "utf8");
    for (const match of source.matchAll(
      /(?<![\w/.-])scripts\/[A-Za-z0-9_./-]+\.(?:sh|mjs|cjs|ts|tsx|mts)/g,
    )) {
      const reference = match[0].replace(/[.,)]+$/, "");
      if (NodeFS.existsSync(NodePath.join(root, reference))) continue;
      if (files.some((file) => file.endsWith(`/${reference}`))) continue;
      missing.push(`${document}: ${reference}`);
    }
  }
  expect(missing).toEqual([]);
});
