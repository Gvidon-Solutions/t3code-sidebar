import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChatAttachmentId } from "@t3tools/contracts";
import * as Config from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Documents from "../provider/DocumentText.ts";
import { receiveForkUpload, clearForkUploads } from "./ForkUploads.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
const dependencies = Secrets.layer.pipe(
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "L-uploads-" })),
  Layer.provideMerge(Documents.layer.pipe(Layer.provideMerge(NodeServices.layer))),
);
it.effect(
  "copies an attachment in retryable chunks through the upload store and rejects gaps",
  () =>
    Effect.gen(function* () {
      const attachment = {
        type: "file" as const,
        id: ChatAttachmentId.make("L-original"),
        name: "L-note.txt",
        mimeType: "text/plain",
        sizeBytes: 6,
      };
      const upload = (offset: number, text: string, final: boolean) =>
        receiveForkUpload({
          action: "upload",
          forkId: "L-handoff",
          attachment,
          offset,
          data: Buffer.from(text).toString("base64"),
          final,
        });
      expect((yield* upload(3, "def", true).pipe(Effect.flip)).code).toBe("invalid_request");
      expect((yield* upload(0, "abc", false)).attachment).toBeNull();
      expect((yield* upload(0, "abc", false)).attachment).toBeNull();
      const result = yield* upload(3, "def", true);
      expect(result.attachment?.id).not.toBe(attachment.id);
      expect(yield* upload(3, "def", true)).toEqual(result);
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      expect(
        yield* fs.readFileString(
          resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: result.attachment!,
          })!,
        ),
      ).toBe("abcdef");
    }).pipe(Effect.provide(dependencies)),
);

it.effect("deletes staged chunks after success and after failure", () =>
  Effect.gen(function* () {
    const config = yield* Config.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staging = path.join(config.stateDir, "fork-uploads");
    const attachment = {
      type: "file" as const,
      id: ChatAttachmentId.make("L-original"),
      name: "L-note.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    };
    const successfulUpload = yield* receiveForkUpload({
      action: "upload",
      forkId: "L-success",
      attachment,
      offset: 0,
      data: Buffer.from("abc").toString("base64"),
      final: true,
    });
    expect((yield* fs.readDirectory(staging)).length).toBe(1);
    yield* clearForkUploads("L-success");
    expect(
      yield* fs.exists(
        resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: successfulUpload.attachment!,
        })!,
      ),
    ).toBe(false);
    expect((yield* fs.readDirectory(staging)).length).toBe(0);
    yield* receiveForkUpload({
      action: "upload",
      forkId: "L-failure",
      attachment,
      offset: 0,
      data: Buffer.from("abc").toString("base64"),
      final: true,
    });
    expect((yield* fs.readDirectory(staging)).length).toBe(1);
    yield* clearForkUploads("L-failure");
    expect((yield* fs.readDirectory(staging)).length).toBe(0);
  }).pipe(Effect.provide(dependencies)),
);
