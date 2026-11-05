import { MeshBootstrap } from "../../../mesh/MeshBootstrap.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { SecretRef, SecretRequestError, ProjectId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunRuntimeInfo } from "../../../run/RunProtocol.ts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  MeshConfigRevision,
  MeshConfigHistory,
  MeshConfigStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Config from "../../../mesh/MeshConfigTestLayer.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import * as Handlers from "./handlers.ts";
import { MeshToolkit } from "./tools.ts";

const decodeRuntime = Schema.decodeUnknownEffect(RunRuntimeInfo);
const decodeRevision = Schema.decodeUnknownEffect(MeshConfigRevision);
const decodeHistory = Schema.decodeUnknownEffect(MeshConfigHistory);
const decodeStatus = Schema.decodeUnknownEffect(MeshConfigStatus);
it.effect(
  "MCP validates, applies, reads, rejects stale bases, rolls back and lists config status/history",
  () =>
    Effect.gen(function* () {
      const tools = yield* MeshToolkit.pipe(
        Effect.provide(Access.HandlersLayer.layer(Handlers.layer)),
      );
      const get = yield* tools
        .handle("t3_mesh_config_get", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(get.at(-1)?.result).toEqual({ current: null, bindings: {} });
      const ownerRuntime = yield* tools
        .handle("t3_run_runtime", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(ownerRuntime.at(-1)?.isFailure).toBe(true);
      expect(ownerRuntime.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      const originalScope = yield* McpInvocationContext;
      const linkedScope = {
        ...originalScope,
        client: {
          sessionId: "peer",
          label: "Laptop",
          linked: true,
          access: "full-access" as const,
        },
      };
      const deniedRuntime = yield* tools.handle("t3_run_runtime", {}).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(McpInvocationContext, {
          ...linkedScope,
          client: { ...linkedScope.client, replicasLimit: false },
        }),
      );
      expect(deniedRuntime.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      const allowedRuntime = yield* tools
        .handle("t3_run_runtime", {})
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provideService(McpInvocationContext, linkedScope),
        );
      const runtime = yield* decodeRuntime(allowedRuntime.at(-1)?.result);
      expect(runtime.command.length).toBeGreaterThan(0);
      expect(runtime.ptyModule).toContain("node-pty");
      const planned = yield* tools
        .handle("t3_mesh_config_plan", { doc: "schema: 1\nmachines: {}" })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(planned.at(-1)?.result).toEqual({ doc: { schema: 1, machines: {} }, actions: [] });
      const applied = yield* tools
        .handle("t3_mesh_config_apply", { doc: { schema: 1, machines: {} }, baseRevision: null })
        .pipe(Stream.unwrap, Stream.runCollect);
      const revision = (yield* decodeRevision(applied.at(-1)?.result)).revision;
      const stale = yield* tools
        .handle("t3_mesh_config_apply", {
          doc: { schema: 1, machines: {}, future: true },
          baseRevision: null,
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(stale.at(-1)?.isFailure).toBe(true);
      expect(stale.at(-1)?.result).toMatchObject({
        _tag: "MeshConfigError",
        reason: "stale_revision",
        current: { revision },
        diff: [{ path: "$.future", before: null, after: true }],
      });
      const rollback = yield* tools
        .handle("t3_mesh_config_rollback", { revision })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect((yield* decodeRevision(rollback.at(-1)?.result)).revision).not.toBe(revision);
      const history = yield* tools
        .handle("t3_mesh_config_history", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect((yield* decodeHistory(history.at(-1)?.result)).revisions).toHaveLength(2);
      const status = yield* tools
        .handle("t3_mesh_status", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect((yield* decodeStatus(status.at(-1)?.result)).servers).toMatchObject([
        { environmentId: "studio" },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Config.layerTest("studio"),
          Layer.mock(Threads.ThreadManagementService)({}),
          Layer.succeed(McpInvocationContext, {
            environmentId: EnvironmentId.make("studio"),
            requestNamespace: "client:test",
            thread: undefined,
            client: { sessionId: "owner", label: "Owner", access: "full-access" },
            issuedAt: 0,
            capabilities: new Set(["orchestration" as const]),
          }),
        ),
      ),
    ),
);

it.effect("consumes one-time password references once and never returns the credential", () =>
  Effect.gen(function* () {
    const tools = yield* MeshToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer)),
    );
    const args = {
      name: "cloudbox",
      kind: "password" as const,
      secretRef: SecretRef.make("secret-ref"),
      projectId: ProjectId.make("project"),
    };
    const first = yield* tools
      .handle("t3_mesh_bootstrap_credential", args)
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(first.at(-1)?.isFailure).toBe(false);
    expect(JSON.stringify(first)).not.toContain("private-one-use-password");
    const second = yield* tools
      .handle("t3_mesh_bootstrap_credential", args)
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(second.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: "Bootstrap secret reference is invalid, expired or already consumed",
    });
  }).pipe(
    Effect.provide(
      Layer.unwrap(
        Effect.sync(() => {
          let consumed = false;
          return Layer.mergeAll(
            NodeServices.layer,
            Config.layerTest("studio"),
            Layer.mock(Threads.ThreadManagementService)({}),
            Layer.mock(SecretRequests)({
              consume: () =>
                consumed
                  ? Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }))
                  : Effect.sync(() => {
                      consumed = true;
                      return "private-one-use-password";
                    }),
            }),
            Layer.mock(MeshBootstrap)({
              credential: (name, credential) =>
                Effect.sync(() => {
                  expect(name).toBe("cloudbox");
                  expect(credential).toEqual({
                    kind: "password",
                    value: "private-one-use-password",
                  });
                }),
            }),
            Layer.succeed(McpInvocationContext, {
              environmentId: EnvironmentId.make("studio"),
              requestNamespace: "client:test",
              thread: undefined,
              client: { sessionId: "owner", label: "Owner", access: "full-access" },
              issuedAt: 0,
              capabilities: new Set(["orchestration" as const]),
            }),
          );
        }),
      ),
    ),
  ),
);
