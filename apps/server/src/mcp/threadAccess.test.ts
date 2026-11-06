import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { readThread, newCommandId } from "./threadAccess.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);

it.effect("reuses command identities when an authenticated peer request is replayed", () =>
  Effect.gen(function* () {
    const commands = (namespace: string) => {
      let sequence = 0;
      return Effect.all([newCommandId(), newCommandId()]).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...client,
          peerCommandIdentity: { namespace, next: () => sequence++ },
        }),
      );
    };
    const first = yield* commands("peer:studio:create-once");
    const repeated = yield* commands("peer:studio:create-once");
    const another = yield* commands("peer:cloudbox:create-once");
    expect(repeated).toEqual(first);
    expect(first[0]).not.toBe(first[1]);
    expect(another).not.toEqual(first);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
