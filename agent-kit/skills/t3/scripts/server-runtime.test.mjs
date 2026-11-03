import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { detectServerUnit, installPublicRuntime, installSshRuntime } from "./server-runtime.mjs";

NodeTest.test("detects an active root system unit even when a stale user unit also exists", () => {
  const system = detectServerUnit("t3.service", (_command, args) => ({
    status: args.includes("is-active") && args.includes("--user") ? 3 : 0,
    stdout: args.includes("--user") ? "old user" : "system",
  }));
  NodeAssert.equal(system.scope, "system");
  NodeAssert.deepEqual(system.prefix, []);
  NodeAssert.equal(system.text, "system");
  NodeAssert.equal(
    detectServerUnit("t3", (_c, args) => ({
      status: args.includes("--user") ? 0 : 4,
      stdout: "user",
    })).scope,
    "user",
  );
  NodeAssert.equal(
    detectServerUnit("t3", () => ({ status: 4, stdout: "" })),
    null,
  );
});

NodeTest.test(
  "installs the public archive without gh and copies an installed linked runtime over SSH",
  async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "N-runtime-"));
    try {
      const version = "0.1.6-sidebar.60";
      NodeFS.mkdirSync(NodePath.join(root, version));
      NodeFS.writeFileSync(NodePath.join(root, version, "t3"), "fixture runtime", { mode: 0o755 });
      const archive = NodeChildProcess.execFileSync("tar", ["-czf", "-", "-C", root, version]);
      const release = {
        tag_name: `sidebar-v${version}`,
        assets: [
          {
            name: `t3-${version}-linux-x64.tar.gz`,
            browser_download_url: "https://example.test/runtime",
          },
        ],
      };
      const installed = await installPublicRuntime({
        home: NodePath.join(root, "public"),
        repository: "acme/t3",
        want: "60",
        fetcher: async (url) =>
          url === "https://example.test/runtime" ? new Response(archive) : Response.json([release]),
      });
      NodeAssert.equal(installed.version, version);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(installed.path, "t3"), "utf8"),
        "fixture runtime",
      );
      const copied = installSshRuntime({
        home: NodePath.join(root, "copy"),
        want: "60",
        destination: "user@peer:2222",
        run: (_command, args, options) =>
          options.encoding ? JSON.stringify({ root, versions: [version] }) : archive,
      });
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(copied.path, "t3"), "utf8"),
        "fixture runtime",
      );
      await NodeAssert.rejects(
        installPublicRuntime({
          home: root,
          repository: "acme/t3",
          want: "latest",
          fetcher: async () => Response.json({ assets: [] }),
        }),
        /no Linux CLI archive/,
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
