import { useAtomValue } from "@effect/atom-react";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type InboxIssueId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { MessageCircleQuestionIcon, PaperclipIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { composerSubmissionIntentForKey } from "../../composer-logic";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { useSoftwareKeyboardOpen } from "../../hooks/useSoftwareKeyboardOpen";
import { useStableCallback } from "../../hooks/useStableCallback";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import {
  getUploadedAttachments,
  releaseAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import {
  attachmentUploadBlockReason,
  formatAttachmentUploadProgress,
} from "../../lib/attachmentUploadState";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import { cn, randomUUID } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import { inboxAtoms } from "../../state/inbox";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type ComposerPromptEditorHandle,
  ComposerPromptEditorTiptap as ComposerPromptEditor,
} from "../ComposerPromptEditorTiptap";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { ComposerBanner } from "../chat/ComposerBanner";
import { ComposerImageThumbnail } from "../chat/ComposerImageThumbnail";
import { ComposerSurface } from "../chat/ComposerSurface";
import {
  classifyComposerAttachmentFile,
  fileAttachmentStagingLimit,
  normalizeComposerImageFileMimeType,
  shouldHandleComposerAttachmentPaste,
} from "../chat/composerAttachmentFiles";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type InboxComposerAttachment = ComposerImageAttachment | ComposerFileAttachment;

const NO_SKILLS: ReadonlyArray<never> = [];

function releaseInboxAttachment(attachment: InboxComposerAttachment) {
  releaseAttachmentUpload(attachment.id);
  if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
}

function reportError(title: string, description?: string) {
  toastManager.add({ type: "error", title, ...(description ? { description } : {}) });
}

/**
 * Fork: the owner's reply box on an inbox issue. The chat composer's surface,
 * editor, attachments and send button, without the thread-only controls
 * (model, modes, context window).
 */
export function InboxComposer(props: {
  environmentId: EnvironmentId;
  issueId: InboxIssueId;
  connected: boolean;
  /** The responsible agent asked the owner something; shown as a banner on the box. */
  waitingForOwner: boolean;
  /** Who reads the comment, for the placeholder. */
  startsConversation: boolean;
  onSent: () => void;
}) {
  const { environmentId, issueId, connected, waitingForOwner, startsConversation, onSent } = props;
  const canComment = useAtomValue(inboxAtoms.commentOnIssue.permissionAtom(environmentId));
  const comment = useAtomCommand(inboxAtoms.commentOnIssue, { label: "inbox comment" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const richTextEnabled = usePrimarySettings((settings) => settings.composerRichTextEnabled);
  const sendShortcut = usePrimarySettings((settings) => settings.sendShortcut);
  const isSoftwareKeyboardOpen = useSoftwareKeyboardOpen();
  const { resolvedTheme } = useTheme();
  const serverConfig = useEnvironment(environmentId)?.serverConfig ?? null;
  const supportsUploads = serverConfig?.environment.capabilities.attachmentUploads === true;
  const fileLimit = fileAttachmentStagingLimit({
    attachmentUploadsCapabilityKnown: serverConfig !== null,
    supportsAttachmentUploads: supportsUploads,
    maxFileAttachmentBytes:
      serverConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
  });

  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [attachments, setAttachments] = useState<ReadonlyArray<InboxComposerAttachment>>([]);
  const attachmentsRef = useRef(attachments);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the latest attachments for the unmount cleanup
  useLayoutEffect(() => {
    attachmentsRef.current = attachments;
  });
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const uploads = useAttachmentUploadStore((state) => state.uploadsByImageId);

  // Unsent uploads die with the box: switching issues discards the draft.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases unsent uploads when the composer unmounts
  useEffect(() => () => attachmentsRef.current.forEach(releaseInboxAttachment), []);

  const disabled = !connected || !canComment;
  const trimmed = text.trim();
  const uploadBlockReason =
    attachments.length === 0
      ? null
      : attachmentUploadBlockReason({
          imageIds: attachments.map((attachment) => attachment.id),
          uploadsByImageId: uploads,
          environmentId,
        });
  const hasContent = trimmed.length > 0 || attachments.length > 0;
  const canSend = !disabled && !sending && hasContent && uploadBlockReason === null;

  const addFiles = async (files: ReadonlyArray<File>) => {
    if (files.length === 0 || disabled) return;
    if (!supportsUploads) {
      reportError("This server does not accept attachments.");
      return;
    }
    let room = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - attachmentsRef.current.length;
    const added: InboxComposerAttachment[] = [];
    for (const file of files) {
      if (room <= 0) {
        reportError(`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files.`);
        break;
      }
      const kind = classifyComposerAttachmentFile(file);
      if (kind === "unsupported-image") {
        reportError(
          `'${file.name}' is not a supported image type.`,
          "Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.",
        );
        continue;
      }
      if (kind === "image") {
        const prepared = await prepareImageForAttachment(
          normalizeComposerImageFileMimeType(file),
          PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
        );
        if (!prepared.ok) {
          reportError(
            prepared.reason === "unreadable"
              ? `'${file.name}' could not be read as an image.`
              : `'${file.name}' is too large to attach, even after compression.`,
          );
          continue;
        }
        added.push({
          type: "image",
          id: randomUUID(),
          name: prepared.file.name || "image",
          mimeType: prepared.file.type,
          sizeBytes: prepared.file.size,
          previewUrl: URL.createObjectURL(prepared.file),
          file: prepared.file,
        });
      } else {
        if (file.size <= 0) {
          reportError(`'${file.name}' is empty or could not be read.`);
          continue;
        }
        if (fileLimit === null || file.size > fileLimit) {
          reportError(
            `'${file.name}' is too large to attach.`,
            fileLimit === null ? undefined : `The limit is ${formatAttachmentSize(fileLimit)}.`,
          );
          continue;
        }
        added.push({
          type: "file",
          id: randomUUID(),
          name: file.name || "file",
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          file,
        });
      }
      room -= 1;
    }
    if (added.length === 0) return;
    for (const attachment of added) startAttachmentUpload({ environmentId, image: attachment });
    setAttachments((current) => [...current, ...added]);
  };

  const remove = (id: string) => {
    const attachment = attachments.find((candidate) => candidate.id === id);
    if (attachment) releaseInboxAttachment(attachment);
    setAttachments((current) => current.filter((candidate) => candidate.id !== id));
  };

  const send = useStableCallback(async () => {
    if (!canSend) return;
    const uploaded = getUploadedAttachments({ environmentId, images: attachments });
    if (uploaded === null) return;
    setSending(true);
    const result = await comment({
      environmentId,
      input: {
        issueId,
        text: trimmed,
        ...(uploaded.length > 0 ? { attachments: uploaded } : {}),
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      // The server copied the uploads into the thread; the staged originals can go.
      attachments.forEach(releaseInboxAttachment);
      setAttachments([]);
      setText("");
      setCursor(0);
      onSent();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      reportError(
        "Could not send the comment",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  const onCommandKeyDown = (key: string, event: KeyboardEvent, isListItem?: boolean) => {
    if (key !== "Enter" || isListItem) return false;
    const intent = composerSubmissionIntentForKey({
      event,
      keybindings,
      isSoftwareKeyboardOpen,
      isDraftThread: false,
      sendShortcut,
      prompt: editorRef.current?.readSnapshot().value ?? "",
    });
    if (intent === null) return false;
    void send();
    return true;
  };

  const placeholder = !connected
    ? "This issue's machine is not connected"
    : !canComment
      ? "You cannot reply from this connection"
      : startsConversation
        ? "Reply to start a conversation with an agent"
        : "Reply to the agent";

  const images = attachments.filter((attachment) => attachment.type === "image");
  const files = attachments.filter((attachment) => attachment.type === "file");
  const draggingFiles = (event: React.DragEvent) =>
    !disabled && supportsUploads && event.dataTransfer.types.includes("Files");

  return (
    <ComposerSurface.Shell>
      <ComposerSurface.Host>
        <form
          className="w-full min-w-0"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          onDragOver={(event) => {
            if (!draggingFiles(event)) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragging(false);
          }}
          onDrop={(event) => {
            setDragging(false);
            if (!draggingFiles(event)) return;
            event.preventDefault();
            void addFiles(Array.from(event.dataTransfer.files));
          }}
        >
          {waitingForOwner ? (
            <ComposerBanner.Dock>
              <ComposerBanner.Column>
                <ComposerBanner.Attachment>
                  <ComposerBanner.Root density="comfortable">
                    <ComposerBanner.Row>
                      <ComposerBanner.Icon>
                        <MessageCircleQuestionIcon />
                      </ComposerBanner.Icon>
                      <ComposerBanner.Content>
                        <span className="min-w-0 truncate leading-7 sm:leading-6">
                          The agent is waiting for your answer
                        </span>
                      </ComposerBanner.Content>
                    </ComposerBanner.Row>
                  </ComposerBanner.Root>
                </ComposerBanner.Attachment>
              </ComposerBanner.Column>
            </ComposerBanner.Dock>
          ) : null}
          <ComposerSurface.Main>
            <div
              className={cn(
                "rounded-3xl transition-[background-color] duration-200",
                dragging && "bg-accent/45 ring-1 ring-inset ring-primary/70",
              )}
            >
              <div className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
                {images.length > 0 ? (
                  <div className="mb-3 flex max-w-full flex-wrap gap-2">
                    {images.map((image) => (
                      <AttachmentFrame
                        key={image.id}
                        attachment={image}
                        environmentId={environmentId}
                        onRemove={remove}
                      >
                        <ComposerImageThumbnail
                          file={image.file}
                          alt={image.name}
                          className="h-full w-full object-cover"
                          fallback={
                            <span className="flex h-full items-center justify-center px-1 text-3xs text-secondary-label">
                              {image.name}
                            </span>
                          }
                        />
                      </AttachmentFrame>
                    ))}
                  </div>
                ) : null}
                {files.length > 0 ? (
                  <div className="mb-3 flex flex-col gap-1">
                    {files.map((file) => (
                      <FileRow
                        key={file.id}
                        file={file}
                        environmentId={environmentId}
                        theme={resolvedTheme}
                        onRemove={remove}
                      />
                    ))}
                  </div>
                ) : null}
                <ComposerPromptEditor
                  ariaLabel="Reply"
                  editorRef={editorRef}
                  richTextEnabled={richTextEnabled}
                  value={text}
                  cursor={cursor}
                  contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
                  skills={NO_SKILLS}
                  disabled={disabled}
                  placeholder={placeholder}
                  className="max-h-60 min-h-12"
                  onChange={(nextValue, nextCursor) => {
                    setText(nextValue);
                    setCursor(nextCursor);
                  }}
                  onCommandKeyDown={onCommandKeyDown}
                  onPaste={(event) => {
                    const pasted = Array.from(event.clipboardData.files);
                    if (
                      pasted.length === 0 ||
                      !shouldHandleComposerAttachmentPaste({
                        files: pasted,
                        plainText: event.clipboardData.getData("text/plain"),
                      })
                    ) {
                      return;
                    }
                    event.preventDefault();
                    void addFiles(pasted);
                  }}
                />
              </div>
              <div className="flex min-w-0 items-center justify-end gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
                {supportsUploads ? (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(event) => {
                        const picked = Array.from(event.currentTarget.files ?? []);
                        event.currentTarget.value = "";
                        void addFiles(picked).then(() => editorRef.current?.focusAtEnd());
                      }}
                    />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={disabled}
                            onPointerDown={(event) => event.preventDefault()}
                            onClick={() => fileInputRef.current?.click()}
                            aria-label="Attach files"
                          />
                        }
                      >
                        <PaperclipIcon />
                      </TooltipTrigger>
                      <TooltipPopup>Attach files</TooltipPopup>
                    </Tooltip>
                  </>
                ) : null}
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex" />}>
                    <SendButton sending={sending} disabled={!canSend} />
                  </TooltipTrigger>
                  <TooltipPopup>{uploadBlockReason ?? "Send"}</TooltipPopup>
                </Tooltip>
              </div>
            </div>
          </ComposerSurface.Main>
        </form>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
  );
}

/** The chat composer's round send button. */
function SendButton({ sending, disabled }: { sending: boolean; disabled: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-label={sending ? "Sending" : "Send"}
      className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight enabled:shadow-message-action/24 hover:scale-105 hover:bg-message-action-hover active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none"
    >
      {sending ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

function UploadOverlay({
  attachment,
  environmentId,
}: {
  attachment: InboxComposerAttachment;
  environmentId: EnvironmentId;
}) {
  const upload = useAttachmentUploadStore((state) => state.uploadsByImageId[attachment.id]);
  if (upload?.status === "uploading") {
    return (
      <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground">
        {formatAttachmentUploadProgress(upload.progress)}
      </span>
    );
  }
  if (upload?.status === "failed") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="overlay"
              size="icon-xs"
              className="absolute bottom-1 left-1"
              onClick={() => retryAttachmentUpload({ environmentId, image: attachment })}
              aria-label={`Retry upload for ${attachment.name}`}
            />
          }
        >
          <RefreshIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">{upload.reason}</TooltipPopup>
      </Tooltip>
    );
  }
  return null;
}

function AttachmentFrame(props: {
  attachment: InboxComposerAttachment;
  environmentId: EnvironmentId;
  onRemove: (id: string) => void;
  children: ReactNode;
}) {
  const { attachment, environmentId, onRemove, children } = props;
  return (
    <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border/80 bg-background">
      {children}
      <UploadOverlay attachment={attachment} environmentId={environmentId} />
      <Button
        variant="media-close"
        size="icon-xs"
        className="absolute top-1 right-1"
        onClick={() => onRemove(attachment.id)}
        aria-label={`Remove ${attachment.name}`}
      >
        <XIcon />
      </Button>
    </div>
  );
}

function FileRow(props: {
  file: ComposerFileAttachment;
  environmentId: EnvironmentId;
  theme: "light" | "dark";
  onRemove: (id: string) => void;
}) {
  const { file, environmentId, theme, onRemove } = props;
  const upload = useAttachmentUploadStore((state) => state.uploadsByImageId[file.id]);
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground">
      <PierreEntryIcon pathValue={file.name} kind="file" mimeType={file.mimeType} theme={theme} />
      <span className="min-w-0 flex-1 truncate">{file.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {upload?.status === "uploading"
          ? formatAttachmentUploadProgress(upload.progress)
          : formatAttachmentSize(file.sizeBytes)}
      </span>
      {upload?.status === "failed" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => retryAttachmentUpload({ environmentId, image: file })}
                aria-label={`Retry upload for ${file.name}`}
              />
            }
          >
            <RefreshIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">{upload.reason}</TooltipPopup>
        </Tooltip>
      ) : null}
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => onRemove(file.id)}
        aria-label={`Remove ${file.name}`}
      >
        <XIcon />
      </Button>
    </div>
  );
}
