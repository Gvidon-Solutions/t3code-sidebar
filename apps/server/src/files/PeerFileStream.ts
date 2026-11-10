import { FilesError, type EnvironmentId, type FilesReadBytesResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as FilesRpc from "./FilesRpc.ts";

/** One response from the peer proxy; larger files continue with a ranged request. */
export const REMOTE_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** Small enough for the peer RPC frame and receipt limits, with base64 headroom. */
export const REMOTE_FILE_CHUNK_BYTES = 512 * 1024;
const REMOTE_PROXY_MAX_CONCURRENT = 4;

export interface RemoteFilePlan {
  readonly status: 200 | 206;
  readonly offset: number;
  readonly length: number;
  readonly contentRange?: string;
}

export type RemoteFilePlanResult =
  | RemoteFilePlan
  | { readonly status: 416; readonly total: number };

const parseRange = (header: string) => {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  return {
    first: match[1] ? Number(match[1]) : null,
    last: match[2] ? Number(match[2]) : null,
  };
};

/**
 * One bounded response. A plain GET of a large file is answered as a 206 of the
 * first 64 MiB, and an open-ended range is bounded the same way so a video player
 * asks for the next range instead of making the server allocate the whole file.
 */
export const planRemoteResponse = (input: {
  readonly rangeHeader?: string | undefined;
  readonly ifRangeHeader?: string | undefined;
  readonly size: number;
  readonly maxBytes?: number;
}): RemoteFilePlanResult => {
  const maxBytes = input.maxBytes ?? REMOTE_FILE_MAX_BYTES;
  const size = Math.max(0, input.size);
  const range =
    input.rangeHeader !== undefined && input.ifRangeHeader === undefined
      ? parseRange(input.rangeHeader)
      : null;
  if (range === null) {
    const length = Math.min(size, maxBytes);
    return size > maxBytes
      ? {
          status: 206,
          offset: 0,
          length,
          contentRange: `bytes 0-${length - 1}/${size}`,
        }
      : { status: 200, offset: 0, length };
  }
  const start = range.first ?? (range.last === null ? 0 : Math.max(0, size - range.last));
  if (size === 0 || start >= size || (range.first === null && range.last === 0)) {
    return { status: 416, total: size };
  }
  const requestedEnd = range.first !== null && range.last !== null ? range.last : size - 1;
  const end = Math.min(requestedEnd, size - 1, start + maxBytes - 1);
  if (end < start) return { status: 416, total: size };
  const length = end - start + 1;
  return {
    status: 206,
    offset: start,
    length,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
};

const shortRead = (absolutePath: string) =>
  new FilesError({
    reason: "operation_failed",
    absolutePath,
    message: "The file changed while it was being read.",
  });

/** One chunk, rejecting a short read while more bytes remain. EOF is not a short read. */
export const readRemoteChunk = Effect.fn("PeerFileStream.readRemoteChunk")(function* (input: {
  readonly filesRpc: FilesRpc.FilesRpc["Service"];
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string;
  readonly offset: number;
  readonly length: number;
}) {
  const chunk: FilesReadBytesResult = yield* input.filesRpc.readBytes({
    environmentId: input.environmentId,
    absolutePath: input.absolutePath,
    offset: input.offset,
    length: input.length,
  });
  const bytes = Uint8Array.from(Buffer.from(chunk.bytes, "base64"));
  const totalBytes = chunk.totalBytes;
  if (bytes.byteLength === 0 && input.offset < totalBytes) {
    return yield* shortRead(input.absolutePath);
  }
  if (bytes.byteLength < input.length && input.offset + bytes.byteLength < totalBytes) {
    return yield* shortRead(input.absolutePath);
  }
  return { bytes, totalBytes };
});

/** Sequential stream with one chunk prefetched (concurrency 2, order preserved). */
export const remoteChunkStream = (input: {
  readonly filesRpc: FilesRpc.FilesRpc["Service"];
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string;
  readonly offset: number;
  readonly length: number;
  readonly totalBytes: number;
  readonly firstBytes?: Uint8Array;
}) => {
  const first = input.firstBytes;
  const start = input.offset + (first?.byteLength ?? 0);
  const end = Math.min(input.offset + input.length, input.totalBytes);
  const offsets: number[] = [];
  for (let offset = start; offset < end; offset += REMOTE_FILE_CHUNK_BYTES) {
    offsets.push(offset);
  }
  const tail = Stream.fromIterable(offsets).pipe(
    Stream.mapEffect(
      (offset) =>
        readRemoteChunk({
          filesRpc: input.filesRpc,
          environmentId: input.environmentId,
          absolutePath: input.absolutePath,
          offset,
          length: Math.min(REMOTE_FILE_CHUNK_BYTES, end - offset),
        }),
      { concurrency: 2 },
    ),
    Stream.map((chunk) => chunk.bytes),
  );
  return first === undefined || first.byteLength === 0
    ? tail
    : Stream.concat(Stream.make(first), tail);
};

let activeProxyResponses = 0;

export const tryAcquireProxySlot = () => {
  if (activeProxyResponses >= REMOTE_PROXY_MAX_CONCURRENT) return false;
  activeProxyResponses += 1;
  return true;
};

export const releaseProxySlot = () => {
  if (activeProxyResponses > 0) activeProxyResponses -= 1;
};

export const activeProxyResponseCount = () => activeProxyResponses;
