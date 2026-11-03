import {
  AttachmentCreateUploadUrlInput,
  ChatAttachment,
  OrchestratorMcpFailure,
  type HandoffBundle,
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
import type { ReceiveHandoffInput } from "./handoffTransport.ts";

const decodeUpload = Schema.decodeUnknownEffect(AttachmentCreateUploadUrlInput);
const decodeAttachment = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatAttachment));
const encodeAttachment = Schema.encodeSync(Schema.fromJsonString(ChatAttachment));
const failure = (_cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Handoff attachment transfer failed.",
  });
export const receiveHandoffUpload = Effect.fn("HandoffUploads.receive")(function* (
  input: Extract<ReceiveHandoffInput, { action: "upload" }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const key = Hex.encode(
    yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`${input.handoffId}\n${input.attachment.id}`))
      .pipe(Effect.mapError(failure)),
  );
  const directory = path.join(config.stateDir, "handoff-uploads", key);
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
export const readHandoffAttachment = Effect.fn("HandoffUploads.read")(function* (
  attachment: HandoffBundle["entries"][number]["attachments"][number],
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
