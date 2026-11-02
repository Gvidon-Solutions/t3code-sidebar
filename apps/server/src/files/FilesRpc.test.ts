import {
  FilesError,
  FilesListResult,
  FilesReadResult,
  OrchestratorMcpFailure,
  EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as FilesRpc from "./FilesRpc.ts";
import * as FilesService from "./FilesService.ts";

const here = EnvironmentId.make("env-here");
const there = EnvironmentId.make("env-there");

const localResult: FilesReadResult = {
  absolutePath: "/srv/app/README.md",
  contents: "# here\n",
  byteLength: 7,
  truncated: false,
};
const remoteResult: FilesReadResult = {
  absolutePath: "/srv/app/README.md",
  contents: "# there\n",
  byteLength: 8,
  truncated: false,
};

const listResult: FilesListResult = {
  parentPath: "/srv/app",
  entries: [{ name: "README.md", absolutePath: "/srv/app/README.md", kind: "file" }],
};

const far = EnvironmentId.make("env-far");

/** Links of this machine: `direct` are linked with full access. */
const linksMock = (direct: ReadonlyArray<EnvironmentId>) =>
  Layer.mock(PeerLinks.PeerLinks)({
    get: (environmentId: EnvironmentId) =>
      Effect.succeed(
        direct.includes(environmentId)
          ? Option.some({ environmentId, access: "full-access", status: "reachable" } as never)
          : Option.none(),
      ),
    list: Effect.succeed(
      direct.map((environmentId) => ({
        environmentId,
        access: "full-access",
        status: "reachable",
      })),
    ),
  } as never);

const service = (readResult: FilesReadResult, list: FilesListResult) => ({
  read: () => Effect.succeed(readResult),
  list: () => Effect.succeed(list),
});

describe("FilesRpc", () => {
  it.effect("reads and lists on this machine without a peer call", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const layer = FilesRpc.layer.pipe(
        Layer.provide(
          Layer.mock(FilesService.FilesService)(service(localResult, listResult) as never),
        ),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({ environmentId: here } as never),
          }),
        ),
        Layer.provide(linksMock([there])),
        Layer.provide(
          Layer.mock(PeerMcpClient.PeerMcpClient)({
            call: (input: unknown) =>
              Ref.update(calls, (current) => [...current, input]).pipe(
                Effect.as(remoteResult as never),
              ),
          } as never),
        ),
      );

      yield* Effect.gen(function* () {
        const rpc = yield* FilesRpc.FilesRpc;
        expect(yield* rpc.read({ absolutePath: "/srv/app/README.md" })).toEqual(localResult);
        expect(
          yield* rpc.read({ environmentId: here, absolutePath: "/srv/app/README.md" }),
        ).toEqual(localResult);
        expect(yield* rpc.list({ partialPath: "/srv/app/" })).toEqual(listResult);
        expect(yield* Ref.get(calls)).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("forwards a read and a list for another machine over the link", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const layer = FilesRpc.layer.pipe(
        Layer.provide(
          Layer.mock(FilesService.FilesService)(service(localResult, listResult) as never),
        ),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({ environmentId: here } as never),
          }),
        ),
        Layer.provide(linksMock([there])),
        Layer.provide(
          Layer.mock(PeerMcpClient.PeerMcpClient)({
            call: (input: { tool: string }) =>
              Ref.update(calls, (current) => [...current, input]).pipe(
                Effect.as(
                  (input.tool === FilesRpc.FILES_READ_TOOL ? remoteResult : listResult) as never,
                ),
              ),
          } as never),
        ),
      );

      yield* Effect.gen(function* () {
        const rpc = yield* FilesRpc.FilesRpc;
        expect(
          yield* rpc.read({ environmentId: there, absolutePath: "/srv/app/README.md" }),
        ).toEqual(remoteResult);
        expect(
          yield* rpc.list({ environmentId: there, partialPath: "/srv/app/", limit: 5 }),
        ).toEqual(listResult);
        const recorded = yield* Ref.get(calls);
        expect(recorded).toMatchObject([
          {
            environmentId: there,
            tool: FilesRpc.FILES_READ_TOOL,
            arguments: { absolutePath: "/srv/app/README.md" },
          },
          {
            environmentId: there,
            tool: FilesRpc.FILES_LIST_TOOL,
            arguments: { partialPath: "/srv/app/", limit: 5 },
          },
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("turns a peer refusal into a files failure the client can show", () =>
    Effect.gen(function* () {
      const layer = FilesRpc.layer.pipe(
        Layer.provide(
          Layer.mock(FilesService.FilesService)(service(localResult, listResult) as never),
        ),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({ environmentId: here } as never),
          }),
        ),
        Layer.provide(linksMock([there])),
        Layer.provide(
          Layer.mock(PeerMcpClient.PeerMcpClient)({
            call: () =>
              Effect.fail(
                new OrchestratorMcpFailure({
                  code: "capability_denied",
                  message: "The link does not allow this.",
                }),
              ),
          } as never),
        ),
      );

      yield* Effect.gen(function* () {
        const rpc = yield* FilesRpc.FilesRpc;
        const error = yield* rpc
          .read({ environmentId: there, absolutePath: "/root/secret" })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(FilesError);
        expect(error.reason).toBe("permission_denied");
        expect(error.message).toBe("The link does not allow this.");
      }).pipe(Effect.provide(layer));
    }),
  );
  it.effect("relays a read for a machine reached only through a linked peer", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<{ tool: string; environmentId: string }>>([]);
      const layer = FilesRpc.layer.pipe(
        Layer.provide(
          Layer.mock(FilesService.FilesService)(service(localResult, listResult) as never),
        ),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({ environmentId: here } as never),
          }),
        ),
        Layer.provide(linksMock([there])),
        Layer.provide(
          Layer.mock(PeerMcpClient.PeerMcpClient)({
            call: (input: { tool: string; environmentId: string }) =>
              Ref.update(calls, (current) => [...current, input]).pipe(
                Effect.as((input.tool === "t3_mesh_routes" ? [far] : remoteResult) as never),
              ),
          } as never),
        ),
      );

      yield* Effect.gen(function* () {
        const rpc = yield* FilesRpc.FilesRpc;
        expect(yield* rpc.read({ environmentId: far, absolutePath: "/srv/app/README.md" })).toEqual(
          remoteResult,
        );
        expect(yield* Ref.get(calls)).toMatchObject([
          { environmentId: there, tool: "t3_mesh_routes" },
          {
            environmentId: there,
            tool: "t3_mesh_relay",
            arguments: {
              environmentId: far,
              tool: FilesRpc.FILES_READ_TOOL,
              arguments: { absolutePath: "/srv/app/README.md" },
            },
            hops: [here],
          },
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );
  it.effect("keeps the target's reason when a forwarded read fails", () =>
    Effect.gen(function* () {
      const layer = FilesRpc.layer.pipe(
        Layer.provide(
          Layer.mock(FilesService.FilesService)(service(localResult, listResult) as never),
        ),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({ environmentId: here } as never),
          }),
        ),
        Layer.provide(linksMock([there])),
        Layer.provide(
          Layer.mock(PeerMcpClient.PeerMcpClient)({
            call: () =>
              Effect.fail(
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `${FilesRpc.FILES_REASON_PREFIX}not_found] No file at /srv/app/missing.md.`,
                }),
              ),
          } as never),
        ),
      );
      const error = yield* Effect.gen(function* () {
        const rpc = yield* FilesRpc.FilesRpc;
        return yield* rpc
          .read({ environmentId: there, absolutePath: "/srv/app/missing.md" })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      expect(error.reason).toBe("not_found");
      expect(error.message).toBe("No file at /srv/app/missing.md.");
    }),
  );
});
