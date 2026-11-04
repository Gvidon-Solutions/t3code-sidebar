import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServerResponse } from "effect/http";
import { PeerConnectionError } from "./PeerSessions.ts";

const Stored = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  text: Schema.String,
});
const encode = Schema.encodeSync(Schema.fromJsonString(Stored));
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Stored));

export class PeerReceipts extends Context.Service<
  PeerReceipts,
  {
    readonly run: (
      environmentId: string,
      key: string,
      body: string,
      operation: Effect.Effect<HttpServerResponse.HttpServerResponse, PeerConnectionError>,
      resumable?: boolean,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, PeerConnectionError>;
  }
>()("t3/peer/connection/PeerReceipts") {}

export const layer = Layer.effect(
  PeerReceipts,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pending = new Map<
      string,
      Deferred.Deferred<HttpServerResponse.HttpServerResponse, PeerConnectionError>
    >();
    const failure = (cause: unknown) =>
      new PeerConnectionError({
        reason: "protocol",
        message: "Peer receipt storage failed",
        cause,
      });
    const run = Effect.fn("PeerReceipts.run")(function* (
      environmentId: string,
      key: string,
      body: string,
      operation: Effect.Effect<HttpServerResponse.HttpServerResponse, PeerConnectionError>,
      resumable = false,
    ) {
      if (key.length > 200)
        return yield* new PeerConnectionError({
          reason: "protocol",
          message: "Peer idempotency key exceeds limit",
        });
      const slot = encodeKey([environmentId, key]);
      const rows = yield* sql<{
        request_body: string;
        result: string | null;
      }>`SELECT request_body, result FROM peer_call_receipts WHERE environment_id=${environmentId} AND request_key=${key}`.pipe(
        Effect.mapError(failure),
      );
      const saved = rows[0];
      const current = pending.get(slot);
      if (saved && saved.request_body !== body)
        return yield* new PeerConnectionError({
          reason: "protocol",
          message: "Idempotency key reused for another call",
        });
      if (current) return yield* Deferred.await(current);
      if (saved?.result) {
        const response = yield* decode(saved.result).pipe(Effect.mapError(failure));
        return HttpServerResponse.text(response.text, {
          status: response.status,
          headers: response.headers,
        });
      }
      if (saved && !resumable)
        return yield* new PeerConnectionError({
          reason: "protocol",
          message:
            "The server stopped while this request was executing; inspect its outcome before submitting another key",
        });
      const completed = yield* Deferred.make<
        HttpServerResponse.HttpServerResponse,
        PeerConnectionError
      >();
      pending.set(slot, completed);
      return yield* Effect.gen(function* () {
        yield* sql`INSERT INTO peer_call_receipts(environment_id,request_key,request_body,result) VALUES (${environmentId},${key},${body},NULL) ON CONFLICT(environment_id, request_key) DO NOTHING`.pipe(
          Effect.mapError(failure),
        );
        const response = yield* operation;
        const web = HttpServerResponse.toWeb(response);
        const text = yield* Effect.promise(() => web.text());
        const headers = Object.fromEntries(web.headers);
        const stored = encode({ status: web.status, headers, text });
        yield* sql`UPDATE peer_call_receipts SET result=${stored} WHERE environment_id=${environmentId} AND request_key=${key}`.pipe(
          Effect.mapError(failure),
        );
        return HttpServerResponse.text(text, { status: web.status, headers });
      }).pipe(
        Effect.onExit((exit) => Deferred.done(completed, exit)),
        Effect.ensuring(Effect.sync(() => pending.delete(slot))),
      );
    });
    return { run };
  }),
);
