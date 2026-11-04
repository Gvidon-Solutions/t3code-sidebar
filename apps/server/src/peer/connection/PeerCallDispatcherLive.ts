// @effect-diagnostics runEffectInsideEffect:off -- The HTTP transport boundary exposes callbacks to the frame decoder.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, type HttpServerRequest } from "effect/http";
import type * as Scope from "effect/Scope";
import * as HttpEffect from "effect/http/HttpEffect";

import * as PeerCredentials from "./PeerCredentials.ts";
import { PeerCallDispatcher, PeerConnectionError } from "./PeerSessions.ts";

const ResponseBody = Schema.Struct({
  result: Schema.optionalKey(
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
      ),
      isError: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(ResponseBody));

export const layer = Layer.effect(
  PeerCallDispatcher,
  Effect.gen(function* () {
    const credentials = yield* PeerCredentials.PeerCredentials;
    const router = yield* HttpRouter.HttpRouter;
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- HttpRouter exposes unknown transport errors; normalize them immediately.
    const application = router.asHttpEffect().pipe(
      Effect.mapError(
        (cause) =>
          new PeerConnectionError({
            reason: "protocol",
            message: "Local MCP dispatch failed",
            cause,
          }),
      ),
    );
    const handle = HttpEffect.toWebHandlerWith<
      never,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >(yield* Effect.context<never>())(application);

    return PeerCallDispatcher.of({
      make: Effect.fn("PeerCallDispatcher.make")(function* (input) {
        const issued = yield* credentials.grant(input.environmentId, input.access);
        const token = input.token ?? issued.token;
        let sessionId: string | undefined;
        let initialization: Promise<void> | undefined;
        const post = async (
          body: unknown,
          headers: Record<string, string>,
          signal: AbortSignal,
        ) => {
          const web = await handle(
            new Request("http://t3.internal/mcp", {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "t3-peer-environment-id": input.environmentId,
                ...headers,
              },
              body: encode(body),
              signal,
            }),
          );
          const text = await web.text();
          return { status: web.status, sessionId: web.headers.get("mcp-session-id"), text };
        };
        const initialize = (signal: AbortSignal) => {
          initialization ??= (async () => {
            const response = await post(
              {
                jsonrpc: "2.0",
                id: 0,
                method: "initialize",
                params: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: { name: "t3-peer", version: "1" },
                },
              },
              {},
              signal,
            );
            if (response.status !== 200 || !response.sessionId)
              throw new Error(
                `Local MCP initialization refused (HTTP ${response.status}, session ${response.sessionId === null ? "absent" : "present"}): ${response.text.slice(0, 300)}`,
              );
            sessionId = response.sessionId;
            await post(
              { jsonrpc: "2.0", method: "notifications/initialized" },
              { "mcp-session-id": sessionId },
              signal,
            );
          })().catch((error: unknown) => {
            initialization = undefined;
            throw error;
          });
          return initialization;
        };
        return {
          token: issued.token,
          expiresAt: issued.expiresAt,
          call: async (body, signal) => {
            if (body.kind !== "tool")
              throw new Error("A relayed call must resolve its destination before dispatch");
            await initialize(signal);
            const response = await post(
              {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                  name: body.tool,
                  arguments: body.arguments,
                },
              },
              {
                "mcp-session-id": sessionId!,
                "mcp-protocol-version": "2025-06-18",
                ...(body.key === undefined ? {} : { "t3-idempotency-key": body.key }),
                "t3-mode-limit": `${body.limits.runtimeMode}/${body.limits.interactionMode}`,
                ...(body.hops === undefined ? {} : { "t3-mesh-hops": body.hops.join(",") }),
              },
              signal,
            );
            if (response.status !== 200)
              return {
                text: encode({
                  code:
                    response.status === 401 || response.status === 403
                      ? "capability_denied"
                      : "orchestration_error",
                  message: `Peer MCP dispatch refused (HTTP ${response.status})`,
                }),
                isError: true,
              };
            const text = response.text.startsWith("data:")
              ? response.text
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trim())
                  .join("")
              : response.text;
            const decoded = decodeResponse(text);
            if (!decoded.result)
              throw new Error(decoded.error?.message ?? "Local MCP returned no result");
            return {
              text: decoded.result.content.map((part) => part.text ?? "").join(""),
              isError: decoded.result.isError === true,
            };
          },
        };
      }),
    });
  }),
);
