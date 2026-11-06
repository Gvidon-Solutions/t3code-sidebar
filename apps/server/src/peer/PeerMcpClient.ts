import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLinkError,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerSessions from "./connection/PeerSessions.ts";
import * as PeerTransport from "./connection/PeerTransport.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

/** The only MCP protocol version a T3 Code `/mcp` registers. */
const PROTOCOL_VERSION = "2025-06-18";
const encodeFailure = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String, message: Schema.String })),
);
const encodeSeed = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** The raw tool answer: MCP text the caller decodes, and whether the tool refused. */
interface PeerCallAnswer {
  readonly text: string;
  readonly isError: boolean;
}

/** The limits a call carries to the peer: the calling agent's modes here. */
export interface PeerCallLimits {
  readonly files?: "all" | "projects" | "none";
  readonly replicas?: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Calls a linked environment's T3 MCP tools as this environment's outside
 * agent. Each call carries the calling agent's limits in `T3-Mode-Limit`, so
 * the peer enforces the narrower of those and the link's own access.
 */
export class PeerMcpClient extends Context.Service<
  PeerMcpClient,
  {
    readonly connectionAvailable?: (environmentId: string) => Effect.Effect<boolean>;
    /** Calls `tool` on the peer and decodes its structured result with `success`. */
    readonly call: <S extends Schema.Decoder<unknown>>(input: {
      readonly environmentId: EnvironmentId;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
      readonly limits: PeerCallLimits;
      readonly hops?: readonly string[];
      readonly idempotencyKey?: string;
      readonly success: S;
    }) => Effect.Effect<S["Type"], OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerMcpClient") {}

const ToolCallResponse = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      ),
      structuredContent: Schema.optional(Schema.Unknown),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const decodeToolCallResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCallResponse));
const decodeFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ code: OrchestratorMcpFailure.fields.code, message: Schema.String }),
  ),
);

/** A peer link problem, as the agent that asked hears it. */
const fromLinkError = (error: PeerLinkError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "unknown_link"
        ? "invalid_request"
        : error.reason === "expired" || error.reason === "incompatible"
          ? "capability_denied"
          : "orchestration_error",
    message: error.message,
  });

/** Not final, so a task already running there resumes once the beta is on there again. */
const linkedEnvironmentsOffThere = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message:
    "The linked environment has Linked environments turned off. Turn it on in its Settings → Labs.",
});

/** The body of an MCP response: JSON, or a single server-sent event carrying JSON. */
const responseJson = (contentType: string | undefined, text: string) =>
  contentType?.includes("text/event-stream") === true
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("")
    : text;

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const transport = yield* Effect.serviceOption(PeerTransport.PeerTransport);
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  // One MCP session per peer and address, reused across calls. The peer keeps
  // sessions in memory, so a restart there answers 404 and we start a new one.
  const sessions = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  const post = (url: string, token: string, body: unknown, headers: Record<string, string>) =>
    httpClient.execute(
      HttpClientRequest.post(`${url}/mcp`).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          ...headers,
        }),
        HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
      ),
    );

  const openSession = Effect.fn("PeerMcpClient.openSession")(function* (
    url: string,
    token: string,
    limitHeader: Record<string, string>,
  ) {
    const initialized = yield* post(
      url,
      token,
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "t3code-peer", version: "1" },
        },
      },
      limitHeader,
    );
    const sessionId = initialized.headers["mcp-session-id"];
    if (initialized.status === 403) return yield* linkedEnvironmentsOffThere;
    if (initialized.status !== 200 || sessionId === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: initialized.status === 401 ? "capability_denied" : "orchestration_error",
        message:
          initialized.status === 401
            ? "The linked environment no longer accepts this link. It may have been revoked there; link it again."
            : `The linked environment refused to start an MCP session (HTTP ${initialized.status}).`,
      });
    }
    yield* post(
      url,
      token,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { ...limitHeader, "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
    );
    return sessionId;
  });

  const callOverHttp = Effect.fn("PeerMcpClient.callOverHttp")(
    function* (input: {
      readonly url: string;
      readonly token: string;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
      readonly limits: PeerCallLimits;
      readonly hops?: readonly string[];
      readonly idempotencyKey?: string;
      readonly callerEnvironmentId?: string;
    }) {
      const limitHeader = {
        ...(input.idempotencyKey === undefined
          ? {}
          : { "t3-idempotency-key": input.idempotencyKey }),
        ...(input.callerEnvironmentId === undefined
          ? {}
          : { "t3-peer-environment-id": input.callerEnvironmentId }),
        ...(input.hops === undefined ? {} : { "t3-mesh-hops": input.hops.join(",") }),
        ...(input.limits.files
          ? { [McpInvocationContext.FILES_LIMIT_HEADER]: input.limits.files }
          : {}),
        ...(input.limits.replicas === false
          ? { [McpInvocationContext.REPLICAS_LIMIT_HEADER]: "false" }
          : {}),
        [McpInvocationContext.MODE_LIMIT_HEADER]: `${input.limits.runtimeMode}/${input.limits.interactionMode}`,
      };
      const sessionKey = `${input.url}\n${input.token}`;
      const callOnce = (sessionId: string) =>
        post(
          input.url,
          input.token,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: input.tool, arguments: input.arguments },
          },
          { ...limitHeader, "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION },
        );
      const existing = (yield* Ref.get(sessions)).get(sessionKey);
      const sessionId = existing ?? (yield* openSession(input.url, input.token, limitHeader));
      // The initialized session outlives a tool request, including a long wait or cancellation.
      if (existing === undefined) {
        yield* Ref.update(sessions, (current) => new Map(current).set(sessionKey, sessionId));
      }
      let response = yield* callOnce(sessionId);
      if (response.status === 404) {
        const renewed = yield* openSession(input.url, input.token, limitHeader);
        yield* Ref.update(sessions, (current) => new Map(current).set(sessionKey, renewed));
        response = yield* callOnce(renewed);
      }
      if (response.status === 401) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "The linked environment no longer accepts this link. It may have been revoked there; link it again.",
        });
      }
      if (response.status === 403) return yield* linkedEnvironmentsOffThere;
      if (response.status !== 200) {
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `The linked environment answered HTTP ${response.status}.`,
        });
      }
      const body = yield* decodeToolCallResponse(
        responseJson(response.headers["content-type"], yield* response.text),
      ).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The linked environment answered in an unexpected shape.",
            }),
        ),
      );
      if (body.error !== undefined) {
        return {
          text: encodeFailure({ code: "invalid_request", message: body.error.message }),
          isError: true,
        };
      }
      if (body.result === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The linked environment returned no result.",
        });
      }
      return {
        text: body.result.content.map((part) => part.text ?? "").join(""),
        isError: body.result.isError === true,
      };
    },
    (effect) =>
      effect.pipe(
        Effect.catchTags({
          HttpClientError: () =>
            Effect.fail(
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "The linked environment stopped answering.",
              }),
            ),
        }),
      ),
  );

  /** One decoding path for both transports: a refusal keeps the peer's own code. */
  const decodeAnswer = <S extends Schema.Decoder<unknown>>(
    success: S,
    answer: PeerCallAnswer,
  ): Effect.Effect<S["Type"], OrchestratorMcpFailure> =>
    answer.isError
      ? Effect.gen(function* () {
          const refused = decodeFailure(answer.text);
          return yield* refused._tag === "Some"
            ? new OrchestratorMcpFailure({
                code: refused.value.code,
                message: refused.value.message,
              })
            : new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: answer.text || "The linked environment refused the call.",
              });
        })
      : Schema.decodeEffect(Schema.fromJsonString(success))(answer.text).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message:
                  "The linked environment's answer did not match this version. Update both environments.",
              }),
          ),
        );

  const call: PeerMcpClient["Service"]["call"] = Effect.fn("PeerMcpClient.call")(
    function* (input) {
      const creates =
        /(?:create|launch|fork|handoff_import|receive_handoff|project_place|delegate_task|schedule_task|thread_send|thread_transfer)/.test(
          input.tool,
        );
      const seed =
        input.idempotencyKey === undefined
          ? creates
            ? [
                input.tool,
                typeof input.arguments.clientRequestId === "string"
                  ? input.arguments.clientRequestId
                  : yield* random.uuidV4().pipe(Effect.orDie),
              ]
            : undefined
          : ["explicit", input.idempotencyKey];
      const key =
        seed === undefined
          ? undefined
          : `peer:${Hex.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(encodeSeed(seed))).pipe(Effect.orDie))}`;
      const argumentsWithIdentity =
        key !== undefined &&
        input.arguments.clientRequestId === undefined &&
        [
          "delegate_task",
          "create_threads",
          "schedule_task",
          "t3_thread_launch",
          "t3_thread_send",
          "t3_thread_move",
        ].includes(input.tool)
          ? { ...input.arguments, clientRequestId: key }
          : input.arguments;
      const optionalSessions: Effect.Effect<Option.Option<PeerSessions.PeerSessions["Service"]>> =
        Effect.serviceOption(PeerSessions.PeerSessions);
      const captured = Option.isSome(transport) ? transport.value.get() : undefined;
      const sessions = captured === undefined ? yield* optionalSessions : Option.some(captured);
      const useConnection =
        Option.isSome(sessions) &&
        (yield* sessions.value.status).some(
          (item) => item.environmentId === input.environmentId && item.state !== "offline",
        );
      let answer: PeerCallAnswer;
      if (useConnection && Option.isSome(sessions)) {
        const result = yield* sessions.value
          .call({
            environmentId: String(input.environmentId),
            ...(key === undefined ? {} : { key }),
            body: {
              kind: "tool",
              tool: input.tool,
              arguments: argumentsWithIdentity,
              limits: input.limits,
              ...(input.hops === undefined ? {} : { hops: [...input.hops] }),
            },
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: error.message,
                }),
            ),
          );
        answer = { text: result.text, isError: result.isError };
      } else {
        const resolved = yield* links
          .resolve(input.environmentId)
          .pipe(Effect.mapError(fromLinkError));
        answer = yield* callOverHttp({
          url: resolved.url,
          token: resolved.token,
          ...(key === undefined ? {} : { idempotencyKey: key }),
          ...(Option.isSome(environment)
            ? { callerEnvironmentId: String(yield* environment.value.getEnvironmentId) }
            : {}),
          tool: input.tool,
          arguments: argumentsWithIdentity,
          limits: input.limits,
          ...(input.hops === undefined ? {} : { hops: input.hops }),
        });
      }
      return answer;
    },
    (effect, input) =>
      effect.pipe(
        Effect.timeout("60 seconds"),
        Effect.catchTags({
          TimeoutError: () =>
            Effect.fail(
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Peer call timed out",
              }),
            ),
        }),
        Effect.tapError((error) =>
          links.recordOutcome(input.environmentId, { error: error.message }),
        ),
        Effect.tap(() => links.recordOutcome(input.environmentId, { error: null })),
        Effect.flatMap((answer) => decodeAnswer(input.success, answer)),
      ),
  );

  return PeerMcpClient.of({
    call,
    connectionAvailable: Effect.fn("PeerMcpClient.connectionAvailable")((environmentId) => {
      const network = Option.isSome(transport) ? transport.value.get() : undefined;
      return network
        ? network.status.pipe(
            Effect.map((states) =>
              states.some(
                (state) => state.environmentId === environmentId && state.state !== "offline",
              ),
            ),
          )
        : Effect.succeed(false);
    }),
  });
});

export const layer = Layer.effect(PeerMcpClient, make).pipe(Layer.provide(NodeCrypto.layer));
