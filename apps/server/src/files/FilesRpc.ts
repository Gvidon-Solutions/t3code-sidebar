import {
  FilesError,
  FilesFailure,
  FilesListResult,
  type FilesListInput,
  type FilesReadBytesInput,
  FilesReadBytesResult,
  type FilesReadInput,
  FilesReadResult,
  type FilesStatInput,
  FilesStatResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { callRouted } from "../mesh/MeshRouting.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as FilesService from "./FilesService.ts";

/** The tool a peer exposes for a forwarded read; only this server calls it. */
export const FILES_READ_TOOL = "t3_files_read";
export const FILES_LIST_TOOL = "t3_files_list";
export const FILES_STAT_TOOL = "t3_files_stat";
export const FILES_READ_BYTES_TOOL = "t3_files_read_bytes";

/**
 * T3 Mesh (fork): reads and lists files on the machine named by the caller.
 * Connected clients call the machine directly; otherwise a connected server
 * forwards the read over its peer link.
 */
export class FilesRpc extends Context.Service<
  FilesRpc,
  {
    readonly read: (input: FilesReadInput) => Effect.Effect<FilesReadResult, FilesError>;
    readonly list: (input: FilesListInput) => Effect.Effect<FilesListResult, FilesError>;
    readonly stat: (input: FilesStatInput) => Effect.Effect<FilesStatResult, FilesError>;
    readonly readBytes: (
      input: FilesReadBytesInput,
    ) => Effect.Effect<FilesReadBytesResult, FilesError>;
  }
>()("t3/files/FilesRpc") {}

/** Marks a FilesError reason inside a forwarded tool failure: `[files:not_found] message`. */
export const FILES_REASON_PREFIX = "[files:";
const decodeFailure = Schema.decodeUnknownOption(FilesFailure);

const asFilesError = (error: OrchestratorMcpFailure, absolutePath: string) => {
  const match = /\[files:([a-z_]+)\] (.*)$/su.exec(error.message);
  const reason = match ? decodeFailure(match[1]) : Option.none();
  return new FilesError({
    reason: Option.isSome(reason)
      ? reason.value
      : error.code === "capability_denied"
        ? "permission_denied"
        : "unavailable",
    absolutePath,
    message: match && Option.isSome(reason) ? match[2]! : error.message,
  });
};

/** A client call is a person's, not an agent's: the link's own access stays the limit. */
const clientLimits = { runtimeMode: "full-access", interactionMode: "default" } as const;

const make = Effect.gen(function* () {
  const files = yield* FilesService.FilesService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;

  const read: FilesRpc["Service"]["read"] = Effect.fn("FilesRpc.read")(function* (input) {
    if (input.environmentId === undefined) {
      return yield* files.read(input);
    }
    const descriptor = yield* environment.getDescriptor;
    if (descriptor.environmentId === input.environmentId) {
      return yield* files.read(input);
    }
    const { environmentId, absolutePath } = input;
    return yield* callRouted(
      { links, peers, self: descriptor.environmentId },
      {
        environmentId,
        tool: FILES_READ_TOOL,
        arguments: { absolutePath },
        limits: clientLimits,
        success: FilesReadResult,
      },
    ).pipe(Effect.mapError((error) => asFilesError(error, absolutePath)));
  });

  const list: FilesRpc["Service"]["list"] = Effect.fn("FilesRpc.list")(function* (input) {
    if (input.environmentId === undefined) {
      return yield* files.list(input);
    }
    const descriptor = yield* environment.getDescriptor;
    if (descriptor.environmentId === input.environmentId) {
      return yield* files.list(input);
    }
    const { environmentId, partialPath, limit } = input;
    return yield* callRouted(
      { links, peers, self: descriptor.environmentId },
      {
        environmentId,
        tool: FILES_LIST_TOOL,
        arguments: { partialPath, ...(limit === undefined ? {} : { limit }) },
        limits: clientLimits,
        success: FilesListResult,
      },
    ).pipe(Effect.mapError((error) => asFilesError(error, partialPath)));
  });

  const stat: FilesRpc["Service"]["stat"] = Effect.fn("FilesRpc.stat")(function* (input) {
    if (input.environmentId === undefined) {
      return yield* files.stat(input);
    }
    const descriptor = yield* environment.getDescriptor;
    if (descriptor.environmentId === input.environmentId) {
      return yield* files.stat(input);
    }
    const { environmentId, absolutePath } = input;
    return yield* callRouted(
      { links, peers, self: descriptor.environmentId },
      {
        environmentId,
        tool: FILES_STAT_TOOL,
        arguments: { absolutePath },
        limits: clientLimits,
        success: FilesStatResult,
      },
    ).pipe(Effect.mapError((error) => asFilesError(error, absolutePath)));
  });

  const readBytes: FilesRpc["Service"]["readBytes"] = Effect.fn("FilesRpc.readBytes")(
    function* (input) {
      if (input.environmentId === undefined) {
        return yield* files.readBytes(input);
      }
      const descriptor = yield* environment.getDescriptor;
      if (descriptor.environmentId === input.environmentId) {
        return yield* files.readBytes(input);
      }
      const { environmentId, absolutePath, offset, length } = input;
      return yield* callRouted(
        { links, peers, self: descriptor.environmentId },
        {
          environmentId,
          tool: FILES_READ_BYTES_TOOL,
          arguments: { absolutePath, offset, length },
          limits: clientLimits,
          success: FilesReadBytesResult,
        },
      ).pipe(Effect.mapError((error) => asFilesError(error, absolutePath)));
    },
  );

  return FilesRpc.of({ read, list, stat, readBytes });
});

export const layer = Layer.effect(FilesRpc, make);
