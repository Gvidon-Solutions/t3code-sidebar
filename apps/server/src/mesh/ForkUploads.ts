import {
  AttachmentCreateUploadUrlInput,
  ChatAttachment,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as ServerConfig from "../config.ts";
import {
  issueAttachmentUploadUrl,
  validateAttachmentUploadToken,
  storeAttachmentUpload,
} from "../assets/AttachmentUpload.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import type { ForkTransportInput } from "./forkTransport.ts";

const decodeUpload = Schema.decodeUnknownEffect(AttachmentCreateUploadUrlInput);
const decodeAttachment = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatAttachment));
const encodeAttachment = Schema.encodeSync(Schema.fromJsonString(ChatAttachment));
const failure = (_cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Fork attachment transfer failed.",
  });

const uploadDirectory = Effect.fn("ForkUploads.directory")(function* (
  forkId: string,
  attachmentId: string,
) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const forkDir = Hex.encode(
    yield* crypto
      .digest("SHA-256", new TextEncoder().encode(forkId))
      .pipe(Effect.mapError(failure)),
  );
  const attachmentKey = Hex.encode(
    yield* crypto
      .digest("SHA-256", new TextEncoder().encode(attachmentId))
      .pipe(Effect.mapError(failure)),
  );
  return path.join(config.stateDir, "fork-uploads", forkDir, attachmentKey);
});

export const receiveForkUpload = Effect.fn("ForkUploads.receive")(function* (
  input: Extract<ForkTransportInput, { action: "upload" }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* uploadDirectory(input.forkId, input.attachment.id);
  yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(failure));
  const receipt = path.join(directory, "attachment.json");
  if (yield* fs.exists(receipt).pipe(Effect.mapError(failure)))
    return {
      attachment: yield* fs
        .readFileString(receipt)
        .pipe(Effect.flatMap(decodeAttachment), Effect.mapError(failure)),
    };
  const bytes = Buffer.from(input.data, "base64");
  if (input.offset + bytes.length > input.attachment.sizeBytes)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Attachment chunk exceeds the declared size.",
    });
  const file = path.join(directory, "bytes");
  const size = (yield* fs.exists(file).pipe(Effect.mapError(failure)))
    ? Number((yield* fs.stat(file).pipe(Effect.mapError(failure))).size)
    : 0;
  if (size === input.offset)
    yield* fs
      .writeFile(file, bytes, { flag: size === 0 ? "w" : "a" })
      .pipe(Effect.mapError(failure));
  else if (size < input.offset + bytes.length)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Attachment chunks must arrive in order.",
    });
  if (!input.final) return { attachment: null };
  const total = Number((yield* fs.stat(file).pipe(Effect.mapError(failure))).size);
  if (total !== input.attachment.sizeBytes)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Attachment upload is incomplete.",
    });
  const upload = yield* decodeUpload({
    type: input.attachment.type === "image" ? "image" : "file",
    name: input.attachment.name,
    mimeType: input.attachment.mimeType,
    sizeBytes: total,
  }).pipe(Effect.flatMap(issueAttachmentUploadUrl), Effect.mapError(failure));
  const token = upload.relativeUrl.split("/").at(-1)!;
  const claims = yield* validateAttachmentUploadToken(token).pipe(Effect.mapError(failure));
  if (!claims) return yield* failure(undefined);
  const stored = yield* storeAttachmentUpload(
    claims,
    yield* fs.readFile(file).pipe(Effect.mapError(failure)),
  ).pipe(Effect.mapError(failure));
  if (!stored.ok)
    return yield* new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: stored.detail,
    });
  const attachment = { ...input.attachment, id: upload.attachmentId };
  yield* fs.writeFileString(receipt, encodeAttachment(attachment)).pipe(Effect.mapError(failure));
  return { attachment };
});

export const readForkAttachment = Effect.fn("ForkUploads.read")(function* (
  attachment: ChatAttachment,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const file = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
  if (!file)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Attachment is not stored on the source machine.",
    });
  return yield* fs.readFile(file).pipe(Effect.mapError(failure));
});

/** Staging survives only while a fork is being received; delete it either way. */
export const clearForkUploads = Effect.fn("ForkUploads.clear")(function* (forkId: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const forkDir = Hex.encode(
    yield* crypto
      .digest("SHA-256", new TextEncoder().encode(forkId))
      .pipe(Effect.mapError(failure)),
  );
  const directory = path.join(config.stateDir, "fork-uploads", forkDir);
  if (yield* fs.exists(directory).pipe(Effect.mapError(failure))) {
    const entries = yield* fs.readDirectory(directory).pipe(Effect.mapError(failure));
    for (const entry of entries) {
      const receipt = path.join(directory, entry, "attachment.json");
      if (!(yield* fs.exists(receipt).pipe(Effect.mapError(failure)))) continue;
      const attachment = yield* fs
        .readFileString(receipt)
        .pipe(Effect.flatMap(decodeAttachment), Effect.mapError(failure));
      const stored = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (stored) {
        yield* fs.remove(stored, { force: true }).pipe(Effect.mapError(failure));
        yield* fs.remove(`${stored}.txt`, { force: true }).pipe(Effect.mapError(failure));
      }
    }
  }
  yield* fs.remove(directory, { recursive: true, force: true }).pipe(Effect.mapError(failure));
});
