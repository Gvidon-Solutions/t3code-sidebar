import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
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
      const duplicate = yield* first
        .run("studio", "request-1", "body", operation)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
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

it.effect("bounds cached response bytes and expires completed and interrupted receipts", () =>
  Effect.gen(function* () {
    const service = yield* Receipts.PeerReceipts;
    const sql = yield* SqlClient.SqlClient;
    const text = "😀".repeat(20_000);
    let calls = 0;
    const operation = Effect.sync(() => {
      calls++;
      return HttpServerResponse.text(text);
    });
    const first = yield* service.run("studio", "large", "body", operation);
    expect(yield* Effect.promise(() => HttpServerResponse.toWeb(first).text())).toBe(text);
    const rows = yield* sql<{
      result: string;
    }>`SELECT result FROM peer_call_receipts WHERE request_key='large'`;
    expect(new TextEncoder().encode(rows[0]!.result).byteLength).toBeLessThanOrEqual(65536);
    expect((yield* service.run("studio", "large", "body", operation)).status).toBe(413);
    expect(calls).toBe(1);
    yield* sql`INSERT INTO peer_call_receipts(environment_id,request_key,request_body,result,created_at) VALUES ('studio','interrupted','body',NULL,0)`;
    yield* TestClock.adjust("31 days");
    yield* service.run("studio", "fresh", "body", Effect.succeed(HttpServerResponse.text("ok")));
    expect(yield* sql`SELECT request_key FROM peer_call_receipts`).toEqual([
      { request_key: "fresh" },
    ]);
  }).pipe(Effect.provide(Receipts.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("reserves a receipt atomically when two services read an absent key together", () =>
  Effect.gen(function* () {
    const database = yield* Layer.build(Sqlite.layerMemory);
    const sql = Context.get(database, SqlClient.SqlClient);
    const readTogether = yield* Deferred.make<void>();
    let reads = 0;
    const racingSql = new Proxy(sql, {
      apply(target, receiver, args: unknown[]) {
        const statement = Reflect.apply(target, receiver, args) as Effect.Effect<
          ReadonlyArray<unknown>,
          unknown
        >;
        if (!Array.isArray(args[0]) || !args[0].join("").includes("SELECT request_body, result"))
          return statement;
        return statement.pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              reads++;
              if (reads === 2) yield* Deferred.succeed(readTogether, undefined);
              yield* Deferred.await(readTogether);
            }),
          ),
        );
      },
    });
    const build = () =>
      Layer.build(
        Layer.fresh(
          Receipts.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, racingSql))),
        ),
      );
    const first = Context.get(yield* build(), Receipts.PeerReceipts);
    const second = Context.get(yield* build(), Receipts.PeerReceipts);
    let created = 0;
    const operation = Effect.sync(() => {
      created++;
      return HttpServerResponse.text("created");
    });
    const results = yield* Effect.all(
      [
        first.run("studio", "racing-key", "body", operation).pipe(Effect.result),
        second.run("studio", "racing-key", "body", operation).pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    expect(created).toBe(1);
    expect(results.some((result) => result._tag === "Success")).toBe(true);
    expect(yield* sql`SELECT request_key FROM peer_call_receipts`).toEqual([
      { request_key: "racing-key" },
    ]);
  }).pipe(Effect.scoped),
);
