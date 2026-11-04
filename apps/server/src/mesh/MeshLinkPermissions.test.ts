import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  type MeshConfigDocument,
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
} from "@t3tools/contracts";
import type { Json } from "@t3tools/shared/meshLayout";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Tool, Toolkit } from "effect/ai";
import { layerTest } from "../replicas/MeshLayoutTestLayer.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import * as Access from "../mcp/McpToolAccess.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import { linkPermissions } from "./MeshLinkPermissions.ts";

const shared = {
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.String,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
};
const toolkit = Toolkit.make(
  Tool.make("t3_thread_read", shared),
  Tool.make("t3_project_place", shared),
);
const handlers = Access.toLayer(toolkit, {
  t3_thread_read: Access.reads(() => Effect.succeed("thread accepted")),
  t3_project_place: Access.reads(() => Effect.succeed("replica accepted")),
});
const scope = Layer.succeed(McpInvocationContext, {
  environmentId: EnvironmentId.make("studio-env"),
  requestNamespace: "link",
  thread: undefined,
  client: {
    sessionId: "peer",
    label: "Misleading label",
    peerEnvironmentId: EnvironmentId.make("laptop-env"),
    linked: true,
    access: "full-access",
  },
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
});
it.effect(
  "enforces thread and replica permissions on receiving handlers using authenticated peer identity",
  () =>
    Effect.gen(function* () {
      const mesh = yield* MeshLayoutService;
      const h = yield* mesh.nextHlc;
      const doc: MeshConfigDocument = {
        schema: 1,
        machines: { studio: { title: "Studio" }, laptop: { title: "Laptop" } },
        links: {
          overrides: [
            { between: ["studio", "laptop"], files: "none", threads: false, replicas: false },
          ],
        },
      };
      yield* mesh.apply({
        "mesh.config": {
          v: { revision: h, doc: doc as Json, author: "studio-env", writtenAt: "" },
          h,
        },
        "mesh.machineBinding/studio": { v: "studio-env", h },
        "mesh.machineBinding/laptop": { v: "laptop-env", h },
      });
      expect(yield* linkPermissions()).toEqual({
        files: "none",
        threads: false,
        replicas: false,
        linked: true,
      });
      const tools = yield* toolkit.pipe(Effect.provide(Access.HandlersLayer.layer(handlers)));
      for (const name of ["t3_thread_read", "t3_project_place"] as const) {
        const result = yield* tools.handle(name, {}).pipe(Stream.unwrap, Stream.runCollect);
        expect(result.at(-1)?.isFailure).toBe(true);
        expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      }
      const allow = yield* mesh.nextHlc;
      yield* mesh.apply({
        "mesh.config": {
          v: {
            revision: allow,
            doc: { schema: 1, machines: doc.machines as Json },
            author: "studio-env",
            writtenAt: "",
          },
          h: allow,
        },
      });
      const result = yield* tools
        .handle("t3_thread_read", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(result.at(-1)?.result).toBe("thread accepted");
    }).pipe(
      Effect.provide(
        Layer.merge(scope, layerTest("studio-env", DEFAULT_SIDEBAR_WORKSPACES_CONFIG)),
      ),
    ),
);
