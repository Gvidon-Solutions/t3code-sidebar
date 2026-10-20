import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatAttachment,
  type EnvironmentId,
  type InboxIssueId,
} from "@t3tools/contracts";
import { TextInputWrapper } from "expo-paste-input";
import { useEffect, useRef, useState } from "react";
import { Alert, Platform, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { composerAttachmentWireMimeType } from "../../lib/attachmentUpload";
import { cn } from "../../lib/cn";
import {
  convertPastedImagesToAttachments,
  isComposerImageAttachment,
  pickComposerFiles,
  pickComposerMedia,
  type DraftComposerAttachment,
  type ComposerMediaSource,
} from "../../lib/composerImages";
import { useNativePaste } from "../../lib/useNativePaste";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
  composerAttachmentsStillUploading,
} from "../../state/composer-attachment-uploads";
import { useServerConfigs } from "../../state/entities";
import {
  appendComposerDraftAttachments,
  composerDraftsAtom,
  removeComposerDraftAttachment,
  setComposerDraftText,
  useComposerDraft,
} from "../../state/use-composer-drafts";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { ComposerSurface, expandedEditorMaxHeight } from "../threads/ThreadComposer";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import {
  COMPOSER_FULL_SCREEN_EXTRA_HEIGHT,
  ComposerFullScreenButton,
  useComposerFullScreen,
} from "../composer-fullscreen/ComposerFullScreen";
import { inboxEnvironment } from "./useInbox";

/**
 * The reply draft lives with the other composer drafts, so it survives a restart and the
 * background upload worker sends its files while the owner types. The key's environment
 * prefix is what the worker reads to know where to upload.
 */
export function inboxCommentDraftKey(environmentId: EnvironmentId, issueId: InboxIssueId): string {
  return `${environmentId}:inbox-${encodeURIComponent(issueId)}`;
}

/** The wire attachment for an uploaded draft attachment, typed the way it was uploaded. */
function uploadedChatAttachment(attachment: DraftComposerAttachment, id: string): ChatAttachment {
  const fields = { id, name: attachment.name, sizeBytes: attachment.sizeBytes };
  return isComposerImageAttachment(attachment)
    ? { type: "image", ...fields, mimeType: composerAttachmentWireMimeType(attachment) }
    : {
        type: "file",
        ...fields,
        mimeType: attachment.mimeType,
        ...(attachment.source ? { source: attachment.source } : {}),
      };
}

/** Fork: the inbox issue's reply box, the thread composer's surface with its attachments. */
export function InboxComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly issueId: InboxIssueId;
  readonly waitingForOwner: boolean;
  readonly startsConversation: boolean;
  readonly bottomInset: number;
  readonly onLayout: (event: LayoutChangeEvent) => void;
}) {
  const { environmentId, issueId } = props;
  const navigation = useNavigation();
  const draftKey = inboxCommentDraftKey(environmentId, issueId);
  const draft = useComposerDraft(draftKey);
  const comment = useAtomCommand(inboxEnvironment.commentOnIssue);
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const capabilities = serverConfig?.environment.capabilities;
  const canAttach = capabilities?.attachmentUploads === true;
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const connected = useRemoteConnectionStatus().connectedEnvironments.some(
    (environment) =>
      environment.environmentId === environmentId && environment.connectionState === "connected",
  );
  const [sending, setSending] = useState(false);
  const bodyText = useScaledTextRole("body");
  const fullScreenEditor = useComposerFullScreen(bodyText.lineHeight);
  const { height: windowHeight } = useWindowDimensions();
  const keyboardHeight = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const safeAreaInsets = useSafeAreaInsets();
  const fullScreenEditorHeight =
    expandedEditorMaxHeight({
      windowHeight,
      keyboardHeight,
      topInset: safeAreaInsets.top,
      bottomInset: props.bottomInset,
    }) + COMPOSER_FULL_SCREEN_EXTRA_HEIGHT;
  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const attachments = draft.attachments;
  const uploadInput = { environmentId, attachments, serverConfig, states: uploadStates };
  const uploading = composerAttachmentsStillUploading(uploadInput);
  const blockReason = composerAttachmentUploadBlockReason({ ...uploadInput, connected });
  const hasContent = draft.text.trim().length > 0 || attachments.length > 0;
  const canSend = hasContent && connected && !sending && !uploading && blockReason === null;

  const existingCount = () =>
    appAtomRegistry.get(composerDraftsAtom)[draftKey]?.attachments.length ?? 0;
  const append = (picked: ReadonlyArray<DraftComposerAttachment>) =>
    appendComposerDraftAttachments(draftKey, picked, {
      maxAttachments: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    });
  const pick = async (kind: "media" | "files", source?: ComposerMediaSource) => {
    try {
      const result =
        kind === "files"
          ? await pickComposerFiles({
              existingCount: existingCount(),
              maxBytes: capabilities?.fileAttachments?.maxUploadBytes,
            })
          : await pickComposerMedia({
              source,
              existingCount: existingCount(),
              maxVideoBytes: capabilities?.fileAttachments?.maxUploadBytes,
            });
      const rejected = append("files" in result ? result.files : result.attachments);
      if (result.error || rejected > 0)
        Alert.alert("Could not attach file", result.error ?? "Too many attachments.");
    } catch (error) {
      Alert.alert("Could not attach file", error instanceof Error ? error.message : "Try again.");
    }
  };
  const paste = useNativePaste((uris) => {
    if (!canAttach) return;
    void convertPastedImagesToAttachments({ uris, existingCount: existingCount() })
      .then((images) => {
        if (append(images) > 0) Alert.alert("Could not paste image", "Too many attachments.");
      })
      .catch((error) =>
        Alert.alert("Could not paste image", error instanceof Error ? error.message : "Try again."),
      );
  });

  const send = async () => {
    if (!canSend) return;
    const text = draft.text.trim();
    const sent = attachments;
    // The upload worker stamps each attachment once its bytes are on this environment.
    const wire = sent.flatMap((attachment) =>
      attachment.uploadedAttachmentId !== undefined &&
      attachment.uploadEnvironmentId === environmentId
        ? [uploadedChatAttachment(attachment, attachment.uploadedAttachmentId)]
        : [],
    );
    if (wire.length !== sent.length) {
      Alert.alert(
        "Attachments are not ready",
        "Wait for uploads to finish, or retry failed uploads.",
      );
      return;
    }
    setSending(true);
    try {
      const result = await comment({
        environmentId,
        input: { issueId, text, ...(wire.length > 0 ? { attachments: wire } : {}) },
      });
      if (result._tag !== "Success") return;
      fullScreenEditor.close();
      // The server now owns the files; drop only what was sent, keep anything typed meanwhile.
      for (const attachment of sent) removeComposerDraftAttachment(draftKey, attachment.id);
      const current = appAtomRegistry.get(composerDraftsAtom)[draftKey]?.text ?? "";
      if (current.trim() === text) setComposerDraftText(draftKey, "");
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  const placeholder = props.startsConversation
    ? "Reply to start a conversation"
    : "Reply to the agent";
  return (
    <View
      // Android has no glass: an opaque strip keeps the feed from showing under the box.
      className={cn(
        "absolute inset-x-0 bottom-0 px-[12px] pt-1.5",
        Platform.OS === "android" && "bg-screen",
      )}
      style={{ paddingBottom: props.bottomInset }}
      onLayout={props.onLayout}
    >
      {props.waitingForOwner ? (
        <View className="mb-2 flex-row items-center gap-2 rounded-2xl border border-composer-border bg-card px-3 py-2">
          <SymbolView
            name="questionmark.bubble"
            size={14}
            tintColorClassName="accent-foreground"
            type="monochrome"
          />
          <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground" numberOfLines={1}>
            The agent is waiting for your answer
          </Text>
        </View>
      ) : null}
      <ComposerSurface
        animateLayout={false}
        style={{
          borderRadius: attachments.length > 0 ? 24 : 27,
          overflow: "hidden",
          paddingVertical: 2,
        }}
      >
        {fullScreenEditor.fullScreen ? (
          <View className="absolute right-1 top-1 z-10">
            <ComposerFullScreenButton fullScreen onPress={fullScreenEditor.close} />
          </View>
        ) : null}
        {attachments.length > 0 && !fullScreenEditor.fullScreen ? (
          <View className="px-[14px] pb-1 pt-3">
            <ComposerAttachmentStrip
              environmentId={environmentId}
              attachments={attachments}
              onRemove={(id) => {
                if (!sending) removeComposerDraftAttachment(draftKey, id);
              }}
              onPressPreview={setPreviewFile}
              onPressVideo={(attachment, sourceIdentifier) =>
                setPreviewVideo({ type: "local", attachment, sourceIdentifier })
              }
              onPressDocument={(attachment) =>
                navigation.navigate("ThreadAttachment", {
                  environmentId: String(environmentId),
                  attachmentId: attachment.id,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: String(attachment.sizeBytes),
                  draftKey,
                })
              }
            />
          </View>
        ) : null}
        <View className="flex-row items-end">
          {canAttach && !fullScreenEditor.fullScreen ? (
            <ComposerAttachmentButton
              disabled={sending}
              supportsFiles={Boolean(capabilities?.fileAttachments)}
              onPickMedia={(source) => pick("media", source)}
              onPickFiles={() => pick("files")}
            />
          ) : (
            <View className="w-3" />
          )}
          <View className="min-w-0 flex-1">
            <TextInputWrapper onPaste={paste}>
              <TextInput
                accessibilityLabel="Reply"
                multiline
                maxLength={20_000}
                placeholder={placeholder}
                placeholderTextColorClassName="accent-foreground-muted"
                value={draft.text}
                onChangeText={(value) => setComposerDraftText(draftKey, value)}
                editable={!sending}
                onContentSizeChange={(event) =>
                  // Minus the py-2.5 padding: the hook counts lines of text.
                  fullScreenEditor.onContentHeightChange(event.nativeEvent.contentSize.height - 20)
                }
                className={cn(
                  "min-h-[44px] border-0 bg-transparent px-1 py-2.5 text-base text-foreground",
                  !fullScreenEditor.fullScreen && "max-h-36",
                )}
                style={
                  fullScreenEditor.fullScreen
                    ? { height: fullScreenEditorHeight, paddingRight: 40, textAlignVertical: "top" }
                    : undefined
                }
              />
            </TextInputWrapper>
          </View>
          {fullScreenEditor.offersFullScreen && !fullScreenEditor.fullScreen ? (
            <ComposerFullScreenButton fullScreen={false} onPress={fullScreenEditor.open} />
          ) : null}
          <ComposerActionButton
            accessibilityLabel={blockReason ?? (uploading ? "Uploading attachments" : "Send reply")}
            icon="arrow.up"
            variant="primary"
            disabled={!canSend}
            onPress={() => void send()}
          />
        </View>
      </ComposerSurface>
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
      <VideoPreviewModal source={previewVideo} onRequestClose={() => setPreviewVideo(null)} />
    </View>
  );
}
