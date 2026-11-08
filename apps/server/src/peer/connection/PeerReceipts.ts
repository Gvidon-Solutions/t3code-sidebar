import * as Clock from "effect/Clock";
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
      {
        body: string;
        completed: Deferred.Deferred<HttpServerResponse.HttpServerResponse, PeerConnectionError>;
      }
    >();
    const failure = (cause: unknown) =>
      new PeerConnectionError({
        reason: "protocol",
        message: "Peer receipt storage failed",
        cause,
      });
    let nextSweep = 0;
    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now < nextSweep) return;
      nextSweep = now + 60 * 60 * 1000;
      yield* sql`DELETE FROM peer_call_receipts WHERE created_at < ${now - 30 * 24 * 60 * 60 * 1000}`;
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          nextSweep = 0;
        }),
      ),
      Effect.mapError(failure),
    );
    yield* sweep;
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
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const current = pending.get(slot);
          if (current) {
            if (current.body !== body)
              return yield* new PeerConnectionError({
                reason: "protocol",
                message: "Idempotency key reused for another call",
              });
            return yield* restore(Deferred.await(current.completed));
          }
          const completed = Deferred.makeUnsafe<
            HttpServerResponse.HttpServerResponse,
            PeerConnectionError
          >();
          pending.set(slot, { body, completed });
          return yield* restore(
            Effect.gen(function* () {
              yield* sweep;
              const rows = yield* sql<{
                request_body: string;
                result: string | null;
              }>`SELECT request_body, result FROM peer_call_receipts WHERE environment_id=${environmentId} AND request_key=${key}`.pipe(
                Effect.mapError(failure),
              );
              const saved = rows[0];
              if (saved && saved.request_body !== body)
                return yield* new PeerConnectionError({
                  reason: "protocol",
                  message: "Idempotency key reused for another call",
                });
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
              if (!saved) {
                const now = yield* Clock.currentTimeMillis;
                const inserted =
                  yield* sql`INSERT INTO peer_call_receipts(environment_id,request_key,request_body,result,created_at) VALUES (${environmentId},${key},${body},NULL,${now}) ON CONFLICT(environment_id, request_key) DO NOTHING RETURNING request_key`.pipe(
                    Effect.mapError(failure),
                  );
                if (!inserted.length)
                  return yield* new PeerConnectionError({
                    reason: "protocol",
                    message: "Another process reserved this peer request; retry the same key",
                  });
              }
              const response = yield* operation;
              const web = HttpServerResponse.toWeb(response);
              const text = yield* Effect.tryPromise({ try: () => web.text(), catch: failure });
              const headers = Object.fromEntries(web.headers);
              const result = encode({ status: web.status, headers, text });
              const stored =
                new TextEncoder().encode(result).byteLength <= 65536
                  ? result
                  : encode({
                      status: 413,
                      headers: { "content-type": "text/plain" },
                      text: "The peer response exceeded the durable receipt limit; inspect its outcome before submitting another key",
                    });
              yield* sql`UPDATE peer_call_receipts SET result=${stored} WHERE environment_id=${environmentId} AND request_key=${key}`.pipe(
                Effect.mapError(failure),
              );
              return HttpServerResponse.text(text, { status: web.status, headers });
            }),
          ).pipe(
            Effect.onExit((exit) => Deferred.done(completed, exit)),
            Effect.ensuring(Effect.sync(() => pending.delete(slot))),
          );
        }),
      );
    });
    return { run };
  }),
);
