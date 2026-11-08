import { McpDomainAnnotation } from "../mcp/McpToolDomain.ts";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { OrchestratorMcpFailure, EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import {
  servePeer,
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
} from "../peer/PeerLinks.testkit.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import * as Mcp from "../mcp/McpHttpServer.ts";
import * as Access from "../mcp/McpToolAccess.ts";
import * as Relay from "./MeshRelay.ts";

const result = Schema.Struct({ ok: Schema.Boolean });
const toolkit = Toolkit.make(
  Tool.make("missing", {
    success: result,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }).annotate(McpDomainAnnotation, "mesh"),
  Tool.make("probe", {
    description: "Probe relay destination",
    success: result,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }).annotate(McpDomainAnnotation, "mesh"),
);
const tools = Mcp.toolkitRegistration(
  toolkit,
  Access.toLayer(toolkit, {
    probe: Access.reads(() => Effect.succeed({ ok: true })),
    missing: Access.reads(() =>
      Effect.fail(
        new OrchestratorMcpFailure({ code: "thread_not_found", message: "Thread was removed." }),
      ),
    ),
  }),
);
it.effect("relays across two real peer links and refuses a third hop and a loop", () =>
  Effect.gen(function* () {
    const cHttp = yield* Layer.build(NodeHttpServer.layerTest.pipe(Layer.fresh));
    const bHttp = yield* Layer.build(NodeHttpServer.layerTest.pipe(Layer.fresh));
    const c = yield* servePeer(descriptorOf("C", "C"), tools).pipe(Effect.provide(cHttp));
    const bContext = yield* Layer.build(
      Relay.layer.pipe(Layer.provideMerge(layerLinkingEnvironment(descriptorOf("B", "B")))),
    );
    yield* linkTo(Context.get(bContext, PeerLinks), c, "full-access");
    const b = yield* servePeer(descriptorOf("B", "B"), tools, bContext).pipe(Effect.provide(bHttp));
    const aContext = yield* Layer.build(layerLinkingEnvironment(descriptorOf("A", "A")));
    yield* linkTo(Context.get(aContext, PeerLinks), b, "full-access");
    const peer = Context.get(aContext, PeerMcpClient);
    const call = (hops: readonly string[], tool = "probe") =>
      peer.call({
        environmentId: EnvironmentId.make("B"),
        tool: "t3_mesh_relay",
        arguments: { environmentId: "C", tool, arguments: {} },
        hops,
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: result,
      });
    expect(yield* call(["A"])).toEqual({ ok: true });
    expect(
      yield* call(["A"], "missing").pipe(
        Effect.match({ onFailure: (error) => error.code, onSuccess: () => "unexpected" }),
      ),
    ).toBe("thread_not_found");
    for (const hops of [["A", "other"], ["B"]])
      expect(
        yield* call(hops).pipe(
          Effect.match({ onFailure: (error) => error.code, onSuccess: () => "unexpected" }),
        ),
      ).toBe("capability_denied");
  }).pipe(Effect.scoped),
);
