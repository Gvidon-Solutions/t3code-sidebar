import { McpDomainAnnotation } from "../mcp/McpToolDomain.ts";
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
import { linkPermissions, forwardedCallLimits } from "./MeshLinkPermissions.ts";

const shared = {
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.String,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
};
const toolkit = Toolkit.make(
  Tool.make("t3_thread_read", shared).annotate(McpDomainAnnotation, "threads"),
  Tool.make("t3_project_place", shared).annotate(McpDomainAnnotation, "replicas"),
  Tool.make("unclassified_fixture", shared),
  Tool.make("owner_fixture", shared).annotate(McpDomainAnnotation, "owner"),
  Tool.make("copy_repo", shared).annotate(McpDomainAnnotation, "filesystem"),
  Tool.make("copy_setup", shared)
    .annotate(McpDomainAnnotation, "replicas")
    .annotate(Tool.Readonly, true),
  Tool.make("read_blob", shared).annotate(McpDomainAnnotation, "files"),
);
const handlers = Access.toLayer(toolkit, {
  t3_thread_read: Access.reads(() => Effect.succeed("thread accepted")),
  t3_project_place: Access.reads(() => Effect.succeed("replica accepted")),
  unclassified_fixture: Access.reads(() => Effect.succeed("unclassified accepted")),
  owner_fixture: Access.reads(() => Effect.succeed("owner accepted")),
  copy_repo: Access.reads(() => Effect.succeed("repo accepted")),
  copy_setup: Access.reads(() => Effect.succeed("copy accepted")),
  read_blob: Access.reads(() => Effect.succeed("file accepted")),
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
      for (const name of [
        "t3_thread_read",
        "t3_project_place",
        "copy_setup",
        "read_blob",
      ] as const) {
        const result = yield* tools.handle(name, {}).pipe(Stream.unwrap, Stream.runCollect);
        expect(result.at(-1)?.isFailure).toBe(true);
        expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      }
      const unclassified = yield* tools
        .handle("unclassified_fixture", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(unclassified.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      for (const tool of ["copy_setup", "read_blob", "copy_repo", "unclassified_fixture"]) {
        const denied = yield* forwardedCallLimits(tool, {
          runtimeMode: "full-access",
          interactionMode: "default",
        }).pipe(Effect.flip);
        expect(denied.code).toBe("capability_denied");
      }
      const ownerOnly = yield* tools
        .handle("owner_fixture", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(ownerOnly.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      const ownerScope = yield* McpInvocationContext;
      const localOwner = yield* tools.handle("owner_fixture", {}).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(McpInvocationContext, {
          ...ownerScope,
          client: { ...ownerScope.client!, linked: false },
        }),
      );
      expect(localOwner.at(-1)?.result).toBe("owner accepted");
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
      expect(
        (yield* forwardedCallLimits("copy_setup", {
          runtimeMode: "full-access",
          interactionMode: "default",
        })).replicas,
      ).toBe(true);
      const result = yield* tools
        .handle("t3_thread_read", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(result.at(-1)?.result).toBe("thread accepted");
      const projectOnlyCopy = yield* tools
        .handle("copy_repo", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(projectOnlyCopy.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      expect(
        (yield* forwardedCallLimits("copy_repo", {
          runtimeMode: "full-access",
          interactionMode: "default",
        }).pipe(Effect.flip)).code,
      ).toBe("capability_denied");
      const invocation = yield* McpInvocationContext;
      expect(
        (yield* linkPermissions().pipe(
          Effect.provideService(McpInvocationContext, {
            ...invocation,
            client: { ...invocation.client!, replicasLimit: false },
          }),
        )).replicas,
      ).toBe(false);
      for (const peerEnvironmentId of ["unknown-env", "studio-env"]) {
        expect(
          yield* linkPermissions().pipe(
            Effect.provideService(McpInvocationContext, {
              ...invocation,
              client: {
                ...invocation.client!,
                label: "Laptop",
                peerEnvironmentId: EnvironmentId.make(peerEnvironmentId),
              },
            }),
          ),
        ).toEqual({ files: "none", replicas: false, threads: false, linked: true });
      }
      const legacy = {
        ...(yield* McpInvocationContext),
        client: {
          sessionId: "legacy",
          label: "Shared",
          linked: true,
          access: "full-access" as const,
        },
      };
      const sharedNames = {
        schema: 1,
        machines: { studio: { title: "Shared" }, laptop: { title: "Shared" } },
        links: { overrides: [{ between: ["studio", "laptop"], files: "all" }] },
      };
      const sharedClock = yield* mesh.nextHlc;
      yield* mesh.apply({
        "mesh.config": {
          h: sharedClock,
          v: { revision: sharedClock, doc: sharedNames, author: "studio-env", writtenAt: "" },
        },
      });
      expect(
        (yield* linkPermissions().pipe(Effect.provideService(McpInvocationContext, legacy))).files,
      ).toBe("none");
      const unrestrictedCopy = yield* tools
        .handle("copy_repo", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(unrestrictedCopy.at(-1)?.result).toBe("repo accepted");
      expect(
        (yield* forwardedCallLimits("copy_repo", {
          runtimeMode: "full-access",
          interactionMode: "default",
        })).files,
      ).toBe("all");
      const ambiguousClock = yield* mesh.nextHlc;
      yield* mesh.apply({
        "mesh.machineBinding/cloudbox": { v: "cloudbox-env", h: ambiguousClock },
        "mesh.config": {
          h: ambiguousClock,
          v: {
            revision: ambiguousClock,
            author: "studio-env",
            writtenAt: "",
            doc: {
              ...sharedNames,
              machines: { ...sharedNames.machines, cloudbox: { title: "Shared" } },
              links: {
                overrides: [
                  ...sharedNames.links.overrides,
                  {
                    between: ["studio", "cloudbox"],
                    files: "none",
                    replicas: false,
                    threads: false,
                  },
                ],
              },
            },
          },
        },
      });
      expect(
        yield* linkPermissions().pipe(Effect.provideService(McpInvocationContext, legacy)),
      ).toEqual({ files: "none", replicas: false, threads: false, linked: true });
      expect((yield* linkPermissions()).files).toBe("all");
      expect(
        (yield* linkPermissions().pipe(
          Effect.provideService(McpInvocationContext, {
            ...legacy,
            client: { ...legacy.client, label: "New peer" },
          }),
        )).files,
      ).toBe("none");
    }).pipe(
      Effect.provide(
        Layer.merge(scope, layerTest("studio-env", DEFAULT_SIDEBAR_WORKSPACES_CONFIG)),
      ),
    ),
);
