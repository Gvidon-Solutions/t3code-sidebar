// @effect-diagnostics nodeBuiltinImport:off -- Exercises the CLI fallback against a real missing local socket and temporary manifest.
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { requestRun } from "./RunClient.ts";
it.live(
  "refuses an unknown or lite representation when the server is down and permits a proven local cwd",
  () =>
    Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-run-client-"));
      const previous = {
        home: process.env.T3CODE_HOME,
        socket: process.env.T3CODE_RUN_SOCKET,
        manifest: process.env.T3CODE_RUN_MANIFEST,
      };
      try {
        process.env.T3CODE_HOME = root;
        delete process.env.T3CODE_RUN_SOCKET;
        process.env.T3CODE_RUN_MANIFEST = NodePath.join(root, "manifest.json");
        expect(await requestRun("resolve", root)).toMatchObject({ ok: false, code: 75 });
        await NodeFSP.writeFile(process.env.T3CODE_RUN_MANIFEST, "{");
        expect(await requestRun("resolve", root)).toMatchObject({ ok: false, code: 75 });
        await NodeFSP.writeFile(
          process.env.T3CODE_RUN_MANIFEST,
          JSON.stringify({
            representations: [{ root, lite: true, title: "Application", machine: "studio" }],
            commands: [],
          }),
        );
        expect(await requestRun("resolve", root)).toMatchObject({ ok: false, code: 75 });
        expect(await requestRun("resolve", NodePath.dirname(root))).toMatchObject({
          ok: true,
          plan: { kind: "local" },
        });
      } finally {
        for (const [key, value] of Object.entries({
          T3CODE_HOME: previous.home,
          T3CODE_RUN_SOCKET: previous.socket,
          T3CODE_RUN_MANIFEST: previous.manifest,
        })) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }),
);
