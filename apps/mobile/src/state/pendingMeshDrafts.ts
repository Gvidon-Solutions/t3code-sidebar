import type { DraftComposerAttachment } from "../lib/composerImages";
import { resolveOwnedComposerAttachmentFileUri } from "../lib/composerAttachmentFiles";
import {
  PendingDraftOutbox,
  decodePendingDraftSends,
} from "@t3tools/client-runtime/state/mesh-layout";
import { writeFileAtomically } from "../lib/atomic-file";

async function storageFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, "mesh-draft-outbox.json");
}
export const pendingMeshDrafts = new PendingDraftOutbox({
  async load() {
    const file = await storageFile();
    return file.exists ? decodePendingDraftSends(JSON.parse(await file.text())) : [];
  },
  async save(sends) {
    await writeFileAtomically(await storageFile(), JSON.stringify(sends));
  },
});

export async function serializePendingAttachments(attachments: readonly DraftComposerAttachment[]) {
  const { File, Paths } = await import("expo-file-system");
  return Promise.all(
    attachments.map(async (attachment) => {
      const inline = attachment.type === "image" ? attachment.dataUrl : undefined;
      const dataUrl =
        inline ??
        `data:${attachment.mimeType};base64,${await new File(resolveOwnedComposerAttachmentFileUri(attachment.fileUri!, Paths.document.uri) ?? attachment.fileUri!).base64()}`;
      return {
        id: attachment.id,
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl,
      };
    }),
  );
}
