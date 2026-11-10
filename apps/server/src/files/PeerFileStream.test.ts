import { EnvironmentId, FilesError, type FilesReadBytesResult } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  activeProxyResponseCount,
  planRemoteResponse,
  readRemoteChunk,
  releaseProxySlot,
  REMOTE_FILE_CHUNK_BYTES,
  REMOTE_FILE_MAX_BYTES,
  remoteChunkStream,
  tryAcquireProxySlot,
} from "./PeerFileStream.ts";
import type * as FilesRpc from "./FilesRpc.ts";

const environmentId = EnvironmentId.make("studio");

const fakeRpc = (
  read: (offset: number, length: number) => FilesReadBytesResult,
): FilesRpc.FilesRpc["Service"] => ({
  read: () => Effect.die("unused"),
  list: () => Effect.die("unused"),
  stat: () => Effect.die("unused"),
  readBytes: ({ offset, length }) => Effect.succeed(read(offset, length)),
});

it("caps a plain GET of a large file at 64 MiB with a ranged 206", () => {
  expect(planRemoteResponse({ size: 200 * 1024 * 1024 })).toEqual({
    status: 206,
    offset: 0,
    length: REMOTE_FILE_MAX_BYTES,
    contentRange: `bytes 0-${REMOTE_FILE_MAX_BYTES - 1}/${200 * 1024 * 1024}`,
  });
  expect(planRemoteResponse({ size: 10 })).toEqual({ status: 200, offset: 0, length: 10 });
});

it("bounds an open-ended range and keeps explicit ranges and 416s", () => {
  const total = 200 * 1024 * 1024;
  expect(planRemoteResponse({ rangeHeader: "bytes=0-", size: total })).toMatchObject({
    status: 206,
    offset: 0,
    length: REMOTE_FILE_MAX_BYTES,
    contentRange: `bytes 0-${REMOTE_FILE_MAX_BYTES - 1}/${total}`,
  });
  expect(planRemoteResponse({ rangeHeader: "bytes=100-199", size: 1000 })).toEqual({
    status: 206,
    offset: 100,
    length: 100,
    contentRange: "bytes 100-199/1000",
  });
  expect(planRemoteResponse({ rangeHeader: "bytes=2000-", size: 1000 })).toEqual({
    status: 416,
    total: 1000,
  });
  expect(
    planRemoteResponse({ rangeHeader: "bytes=0-", ifRangeHeader: '"x"', size: total }),
  ).toMatchObject({ status: 206, length: REMOTE_FILE_MAX_BYTES });
});

it("keeps the peer chunk small enough for a base64 RPC frame", () => {
  expect(Math.ceil(REMOTE_FILE_CHUNK_BYTES / 3) * 4).toBeLessThan(750_000);
  expect(REMOTE_FILE_CHUNK_BYTES).toBeLessThan(REMOTE_FILE_MAX_BYTES);
});

it.effect("rejects a short read while more bytes remain", () => {
  const rpc = fakeRpc((offset) => ({
    absolutePath: "/srv/a.bin",
    offset,
    bytes: Buffer.alloc(10, 1).toString("base64"),
    totalBytes: 100,
  }));
  return readRemoteChunk({
    filesRpc: rpc,
    environmentId,
    absolutePath: "/srv/a.bin",
    offset: 0,
    length: 20,
  }).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error).toBeInstanceOf(FilesError);
        expect(error.reason).toBe("operation_failed");
      }),
    ),
  );
});

it.effect("a file that shrinks ends cleanly at its new size", () =>
  Effect.gen(function* () {
    const rpc = fakeRpc((offset) => ({
      absolutePath: "/srv/a.bin",
      offset,
      bytes: Buffer.alloc(offset === 0 ? 5 : 0, 1).toString("base64"),
      totalBytes: 5,
    }));
    const chunks = yield* remoteChunkStream({
      filesRpc: rpc,
      environmentId,
      absolutePath: "/srv/a.bin",
      offset: 0,
      length: 100,
      totalBytes: 10,
    }).pipe(Stream.runCollect);
    const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    expect(bytes).toBe(5);
  }),
);

it("caps concurrent proxy responses", () => {
  for (let index = 0; index < 4; index += 1) expect(tryAcquireProxySlot()).toBe(true);
  expect(tryAcquireProxySlot()).toBe(false);
  releaseProxySlot();
  expect(activeProxyResponseCount()).toBe(3);
  releaseProxySlot();
  releaseProxySlot();
  releaseProxySlot();
});
