import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServerResponse } from "effect/http";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Receipts from "./PeerReceipts.ts";

it.effect(
  "dedupes simultaneous creation and replays its durable result after reopening the service",
  () =>
    Effect.gen(function* () {
      const database = yield* Layer.build(Sqlite.layerMemory);
      const build = () =>
        Layer.build(
          Receipts.layer.pipe(Layer.provide(Layer.succeedContext(database)), Layer.fresh),
        );
      const first = Context.get(yield* build(), Receipts.PeerReceipts);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let created = 0;
      const operation = Effect.gen(function* () {
        created++;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        return HttpServerResponse.text("created");
      });
      const initial = yield* first
        .run("studio", "request-1", "body", operation)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const duplicate = yield* first
        .run("studio", "request-1", "body", operation)
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(initial);
      yield* Fiber.join(duplicate);
      expect(created).toBe(1);
      const reopened = Context.get(yield* build(), Receipts.PeerReceipts);
      const response = yield* reopened.run("studio", "request-1", "body", operation);
      expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).text())).toBe(
        "created",
      );
      expect(created).toBe(1);
      const conflict = yield* reopened
        .run("studio", "request-1", "different", operation)
        .pipe(Effect.result);
      expect(conflict._tag).toBe("Failure");
      const sql = Context.get(database, SqlClient.SqlClient);
      yield* sql`INSERT INTO peer_call_receipts(environment_id,request_key,request_body,result) VALUES ('studio','interrupted','body',NULL)`;
      const unfinished = Context.get(yield* build(), Receipts.PeerReceipts);
      const refused = yield* unfinished
        .run("studio", "interrupted", "body", operation)
        .pipe(Effect.result);
      expect(refused._tag).toBe("Failure");
      const resumed = yield* unfinished.run("studio", "interrupted", "body", operation, true);
      expect(yield* Effect.promise(() => HttpServerResponse.toWeb(resumed).text())).toBe("created");
      expect(created).toBe(2);
    }).pipe(Effect.scoped),
);
