import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import type { ComposerTextPaste } from "../../native/T3ComposerEditor.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { pastedTextDisposition, replaceTextSelection } from "@t3tools/client-runtime/text-paste";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ChatAttachment,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerConfig as T3ServerConfig,
  type UsageLimitsReport,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  hasProviderUsageLimits,
  isUsageLimitsCommand,
} from "@t3tools/shared/usageLimits";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Keyboard,
  Platform,
  useWindowDimensions,
  View,
  type ViewInstance,
  type ViewStyle,
} from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { composerImageGallery } from "../../lib/composerImageGallery";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadsAtom,
} from "../../state/composer-attachment-uploads";
import Animated, {
  FadeIn,
  FadeOut,
  type LayoutAnimationFunction,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  getComposerDraftSnapshot,
  composerDraftsAtom,
  setComposerDraftText,
  composerContextImportsAtom,
  countComposerDraftAttachmentsAfterSelection,
  useComposerDraft,
} from "../../state/use-composer-drafts";
import { appAtomRegistry } from "../../state/atom-registry";
import type { ComposerDocumentAttachment } from "../../lib/composerContext";
import { useProject, useThreadShell, useThreadShells } from "../../state/entities";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { AppText as Text } from "../../components/ui/AppText";
import { ComposerAttachmentButton } from "./ComposerAttachmentButton";
import {
  ComposerAttachmentStrip,
  ComposerAttachmentThumbnail,
} from "../../components/ComposerAttachmentStrip";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import {
  COMPOSER_FULL_SCREEN_EXTRA_HEIGHT,
  ComposerFullScreenButton,
  useComposerFullScreen,
} from "../composer-fullscreen/ComposerFullScreen";
import { fileRoutePathSegments } from "../files/filePath";
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarRow,
} from "../../components/ComposerToolbar";
import { ProviderIcon, ProviderInstanceIcon } from "../../components/ProviderIcon";
import {
  composerStripAttachments,
  type DraftComposerFileAttachment,
  type ComposerMediaSource,
} from "../../lib/composerImages";
import {
  buildModelOptions,
  groupByProvider,
  isModelSelectionUnavailable,
} from "../../lib/modelOptions";
import { useScaledTextRole, type ScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { Menu } from "../../components/ui/Menu";
import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";
import type { FollowUpBehavior } from "../../lib/followUpBehavior";
import {
  resolveComposerSendPresentation,
  type ComposerSendPresentation,
} from "./composerSendPresentation";
import { ComposerCommandPopover } from "./ComposerCommandPopover";
import { ComposerPopoverAnchor } from "./ComposerPopoverAnchor";
import { ComposerQueuedEditAttachments } from "./ComposerQueuedEdit";
import { useComposerCommandMenu } from "./use-composer-command-menu";
import {
  ComposerDictationCancelAction,
  ComposerDictationDraftContent,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import {
  ComposerVoiceElsewhereStrip,
  ComposerVoiceModeButton,
  ComposerVoiceStrip,
} from "../voice-mode/ComposerVoiceMode";
import { useVoiceModePhase } from "../voice-mode/useVoiceMode";
import { voiceMode, voiceModeSupported } from "../voice-mode/voiceMode";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "./ThreadSettingsSheet";
import { QuickModelSheet } from "./QuickModelSheet";
import { modelOptionDisplay, resolveModelDisplay } from "./modelDisplay";
import { formatModelSlugName } from "@t3tools/shared/model";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";

export const COMPOSER_COLLAPSED_CHROME = 60;

const COLLAPSED_EDITOR_DEFAULT_INSET = 6;
// iOS puts line-height slack above glyphs. DM Sans's lowercase midline is
// descender (0.31em) + half x-height (0.504em) above the line bottom.
const LOWERCASE_MIDLINE_EM = 0.562;

function lowercaseMidline(text: ScaledTextRole): number {
  return text.lineHeight - LOWERCASE_MIDLINE_EM * text.fontSize;
}

function collapsedEditorInset(text: ScaledTextRole): number {
  const shift = lowercaseMidline(text) - lowercaseMidline(MOBILE_TYPOGRAPHY.body);
  return Math.max(0, Math.round(COLLAPSED_EDITOR_DEFAULT_INSET - shift));
}

/** The focused editor's smallest height: about two lines before it starts to grow. */
export const EXPANDED_EDITOR_MIN_HEIGHT = 48;
/** Header, toolbar, card padding and a glimpse of the thread kept visible above the editor. */
const EXPANDED_EDITOR_RESERVED_HEIGHT = 56 + 48 + 16 + 16 + 96;

/**
 * The focused editor grows with its text up to the space above the keyboard,
 * leaving room for the header, the toolbar and a strip of the thread, then
 * scrolls inside, the way chat apps let a long prompt take the screen.
 */
export function expandedEditorMaxHeight(input: {
  readonly windowHeight: number;
  readonly keyboardHeight: number;
  readonly topInset: number;
  readonly bottomInset: number;
}): number {
  const available =
    input.windowHeight -
    input.keyboardHeight -
    input.topInset -
    input.bottomInset -
    EXPANDED_EDITOR_RESERVED_HEIGHT;
  return Math.max(160, Math.round(available));
}

export interface ThreadComposerProps {
  readonly isDraft?: boolean;
  readonly canOperateThread: boolean;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly bottomInset?: number;
  /** Window y the full-screen editor grows up to, just below the screen's header. */
  readonly fullScreenTop?: number | null;
  readonly connectionState: RemoteClientConnectionState;
  readonly environmentLabel: string | null;
  readonly threadSyncPhase?: "loading" | "syncing" | null;
  readonly selectedThread: EnvironmentThreadShell;
  readonly reportedModelSelection?: ModelSelection | null;
  readonly hasCompactableConversation: boolean;
  readonly serverConfig: T3ServerConfig | null;
  readonly queueCount: number;
  readonly activeThreadBusy: boolean;
  readonly canStopThread: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string | null;
  readonly sendBlockedReason?: string | null;
  readonly interactionLocked?: boolean;
  /** Sidebar fork: a draft's voice button, which creates the thread before talking. */
  readonly draftVoice?: { readonly canStart: boolean; readonly start: () => void } | null;
  readonly draftKey?: string;
  readonly queuedEdit?: {
    readonly existingAttachments: ReadonlyArray<ChatAttachment>;
    readonly saving: boolean;
    readonly onRemoveExistingAttachment: (attachmentId: string) => void;
  } | null;
  readonly followUpBehavior: FollowUpBehavior;
  readonly canSteerActiveTurn: boolean;
  readonly hidden: boolean;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: (source: ComposerMediaSource) => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onNativePasteText: (paste: ComposerTextPaste) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  /** Present while the thread's queue is held. */
  readonly onResumeQueue: (() => Promise<void>) | null;
  /** `stillSendable` reports whether the draft is unchanged after any wait before sending. */
  readonly onSendMessage: (
    followUp?: ActiveTurnComposerAction,
    stillSendable?: () => boolean,
  ) => Promise<MessageId | null>;
  readonly onShowUsageLimits: (report: UsageLimitsReport | null) => void;
  readonly canSwitchProvider: boolean;
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateInteractionMode?: (interactionMode: ProviderInteractionMode) => void;
  readonly onHeightChange?: (height: number) => void;
  readonly onEditorFocusChange?: (focused: boolean) => void;
}

// Android gets NO layout transition: the composer rides the keyboard via KeyboardStickyView
// (frame-synced to the IME), and a time-based morph running alongside that translate reads as
// jitter.
export const COMPOSER_TRANSITION_DURATION_MS = 220;
// Side panes already animate the dock's width. Nested horizontal layout
// transitions would leave the surface trailing its toolbar's new position.
const composerHeightTransition: LayoutAnimationFunction = (values) => {
  "worklet";
  const timing = {
    duration: COMPOSER_TRANSITION_DURATION_MS,
    reduceMotion: ReduceMotion.System,
  };
  return {
    initialValues: {
      originX: values.targetOriginX,
      originY: values.currentOriginY,
      width: values.targetWidth,
      height: values.currentHeight,
    },
    animations: {
      originX: values.targetOriginX,
      originY: withTiming(values.targetOriginY, timing),
      width: values.targetWidth,
      height: withTiming(values.targetHeight, timing),
    },
  };
};
export const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === "android" ? undefined : composerHeightTransition;
// Share of the one-row composer the draft keeps; a long model name truncates first.
const INLINE_EDITOR_MIN_WIDTH = "40%";
const INLINE_EDITOR_HEIGHT = 36;

const COMPOSER_ATTACHMENT_ENTERING =
  Platform.OS === "android"
    ? FadeIn.duration(160)
    : FadeIn.delay(COMPOSER_TRANSITION_DURATION_MS).duration(160).reduceMotion(ReduceMotion.System);

const AnimatedGlassSurface = Animated.createAnimatedComponent(GlassSurface);

const FOLLOW_UP_ACTION_LABEL = {
  queue: "Queue",
  steer: "Steer now",
  restart: "Restart turn",
} as const;

const FOLLOW_UP_ACTION_SUBTITLE = {
  queue: "Run after the current turn",
  steer: "Interrupt what the agent is doing",
  restart: "Start the turn over with this message",
} as const;

function SendActionButton(props: {
  readonly size?: "regular" | "large";
  readonly accessibilityLabel: string;
  readonly presentation: ComposerSendPresentation;
  readonly disabled: boolean;
  readonly onSend: (followUp?: ActiveTurnComposerAction) => void;
}) {
  const { presentation } = props;
  const button = (
    <ComposerActionButton
      accessibilityLabel={props.accessibilityLabel}
      size={props.size}
      icon={presentation.icon}
      variant="primary"
      disabled={props.disabled}
      onPress={() => props.onSend()}
    />
  );
  if (!presentation.offersFollowUpChoice || presentation.action === null || props.disabled) {
    return button;
  }
  const actions = [presentation.action, presentation.alternate].filter(
    (action): action is ActiveTurnComposerAction => action !== null,
  );
  return (
    <Menu
      accessibilityLabel="Choose how to send this message"
      shouldOpenOnLongPress
      actions={actions.map((action) => ({
        id: action,
        title: FOLLOW_UP_ACTION_LABEL[action],
        subtitle: FOLLOW_UP_ACTION_SUBTITLE[action],
        state: action === presentation.action ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) =>
        props.onSend(nativeEvent.event as ActiveTurnComposerAction)
      }
    >
      {button}
    </Menu>
  );
}

export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  readonly animateLayout?: boolean;
}) {
  const colors = useUniwindTheme();
  const targetBorderRadius =
    typeof props.style.borderRadius === "number" ? props.style.borderRadius : 0;
  const animatedBorderRadius = useSharedValue(targetBorderRadius);
  const shouldAnimate = props.animateLayout !== false && Platform.OS !== "android";
  useLayoutEffect(() => {
    animatedBorderRadius.value = shouldAnimate
      ? withTiming(targetBorderRadius, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : targetBorderRadius;
  }, [animatedBorderRadius, shouldAnimate, targetBorderRadius]);
  const borderCurve = props.style.borderCurve;
  const animatedShapeStyle = useAnimatedStyle(() => ({
    borderRadius: animatedBorderRadius.value,
    ...(borderCurve ? { borderCurve } : {}),
  }));
  const layoutTransition = shouldAnimate ? COMPOSER_LAYOUT_TRANSITION : undefined;

  // Each native frame follows the same transition. Animating only the outer
  // clip leaves the glass and content at their final height on the first frame.
  return (
    <Animated.View
      className={
        Platform.OS === "android" ? undefined : "shadow-[0_6px_28px] shadow-adaptive-black-a15-a35"
      }
      layout={layoutTransition}
      style={[
        animatedShapeStyle,
        {
          overflow: "hidden",
        },
      ]}
    >
      <AnimatedGlassSurface
        chrome="none"
        fallbackColor={colors["--color-composer-surface"]}
        fallbackClassName="border border-composer-border"
        glassEffectStyle="regular"
        pointerEvents="none"
        tintColor="transparent"
        layout={layoutTransition}
        style={[{ position: "absolute", inset: 0 }, animatedShapeStyle]}
      >
        {null}
      </AnimatedGlassSurface>
      <Animated.View
        collapsable={false}
        layout={layoutTransition}
        style={[props.style, animatedShapeStyle]}
      >
        {props.children}
      </Animated.View>
    </Animated.View>
  );
}

/** Space below the composer pill, inside the bottom inset it is given. */
export const THREAD_COMPOSER_BOTTOM_GUTTER = 6;

export const ThreadComposer = function ThreadComposer(props: ThreadComposerProps) {
  const project = useProject(scopeProjectRef(props.environmentId, props.selectedThread.projectId));
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const composerPanel = materialTheme["--color-composer-panel"];
  const navigation = useNavigation();
  const foregroundColor = useUniwindTheme()["--color-foreground"];
  const bodyText = useScaledTextRole("body");
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
  const fullScreenEditor = useComposerFullScreen(bodyText.lineHeight);
  const pendingPastedTextAttachmentCountRef = useRef(0);
  const pendingNativeImagePasteCountRef = useRef(0);
  const [pendingPastedTextAttachmentCount, setPendingPastedTextAttachmentCount] = useState(0);
  const settingsSheetPresentation = useThreadSettingsSheetPresentation({
    editorRef: inputRef,
    isEditorFocused: isFocused,
  });
  const settingsRoutePresentation = useExistingThreadSettingsRoutePresentation();
  const settingsRoutePresentedRef = useRef(false);
  const wasExpandedBeforePreviewRef = useRef(false);
  const inFlightThreadIdsRef = useRef(new Set<string>());

  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const composerOwnerKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const composerDraftKey = props.draftKey ?? composerOwnerKey;
  const { text: draftMessage, attachments: draftAttachments } = useComposerDraft(composerDraftKey);
  const queuedEdit = props.queuedEdit ?? null;
  const hasContent =
    draftMessage.trim().length > 0 ||
    draftAttachments.length > 0 ||
    (queuedEdit?.existingAttachments.length ?? 0) > 0;
  const stripAttachments = composerStripAttachments(draftAttachments);
  const showStopAction = !hasContent && props.canStopThread && queuedEdit === null;
  const onResumeQueue = props.onResumeQueue;
  const [resumingQueue, setResumingQueue] = useState(false);
  const showResumeAction =
    !hasContent && !showStopAction && queuedEdit === null && onResumeQueue !== null;
  const handleResumeQueue = async () => {
    if (resumingQueue || onResumeQueue === null) return;
    setResumingQueue(true);
    await onResumeQueue();
    setResumingQueue(false);
  };

  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const attachmentsUploading =
    props.connectionState === "connected" &&
    composerAttachmentsStillUploading({
      environmentId: props.environmentId,
      attachments: draftAttachments,
      serverConfig: props.serverConfig,
      states: uploadStates,
    });
  const sendPresentation = resolveComposerSendPresentation({
    editingQueuedMessage: queuedEdit !== null,
    running: props.activeThreadBusy,
    canSteer: props.canSteerActiveTurn,
    followUpBehavior: props.followUpBehavior,
    deliveryDeferred:
      props.connectionState !== "connected" || props.queueCount > 0 || attachmentsUploading,
  });
  const sendLabel = sendPresentation.label;
  const currentModelSelection = props.selectedThread.modelSelection;
  const currentRuntimeMode = props.selectedThread.runtimeMode;
  const modelUnavailable =
    props.connectionState === "connected" &&
    isModelSelectionUnavailable(
      props.serverConfig,
      currentModelSelection,
      props.selectedThread.projectId,
    );
  const selectedProviderStatus = (() => {
    if (!props.serverConfig) return null;
    return (
      props.serverConfig.providers.find(
        (p) => p.instanceId === props.selectedThread.modelSelection.instanceId,
      ) ?? null
    );
  })();
  const openDraftDocument = (attachment: ComposerDocumentAttachment) => {
    Keyboard.dismiss();
    navigation.navigate("ThreadAttachment", {
      environmentId: String(props.environmentId),
      threadId: String(props.selectedThread.id),
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: String(attachment.sizeBytes),
      draftKey: composerDraftKey,
    });
  };
  const { onSendMessage, onChangeDraftMessage, onShowUsageLimits } = props;
  const usageLimitsOffered =
    selectedProviderStatus !== null &&
    hasProviderUsageLimits(
      selectedProviderStatus.driver,
      props.serverConfig?.providers ?? [],
      props.serverConfig?.usageLimitSources ?? [],
    );
  const openUsageLimits = () => {
    const report = collectProviderUsageLimits(
      currentModelSelection.instanceId,
      props.serverConfig?.providers ?? [],
      props.serverConfig?.usageLimitSources ?? [],
      Date.now(),
    );
    onShowUsageLimits(report);
    if (!report) {
      Dialog.alert("Usage limits unavailable", "This provider does not currently report limits.");
    }
    return report !== null;
  };

  const composerMenu = useComposerCommandMenu({
    draftMessage: draftMessage,
    ownerKey: composerDraftKey,
    environmentId: props.environmentId,
    threadShells: useThreadShells(),
    currentThreadId: props.selectedThread.id,
    projectCwd: props.projectCwd,
    pullRequestProjectId: props.serverConfig?.environment.capabilities.pullRequests
      ? (project?.id ?? null)
      : null,
    pullRequestRepository: project?.repositoryIdentity?.displayName ?? null,
    threadPullRequests: props.selectedThread.pullRequests,
    selectedProviderStatus,
    hasThread: !props.isDraft,
    hasCompactableConversation: props.hasCompactableConversation,
    onChangeDraftMessage: props.onChangeDraftMessage,
    onUpdateInteractionMode:
      selectedProviderStatus?.showInteractionModeToggle === false
        ? undefined
        : props.onUpdateInteractionMode,
    offersUsageLimits: usageLimitsOffered,
    onUsageLimits:
      usageLimitsOffered && draftAttachments.length === 0 ? openUsageLimits : undefined,
  });
  const voiceTarget = useMemo(
    () => ({ environmentId: props.environmentId, threadId: props.selectedThread.id }),
    [props.environmentId, props.selectedThread.id],
  );
  const voicePhase = useVoiceModePhase(voiceTarget);
  // Sidebar fork: the server starts the provider session for any thread it
  // has, so only a queued creation (a stand-in with no server shell yet) waits.
  const threadOnServer =
    useThreadShell(scopeThreadRef(props.environmentId, props.selectedThread.id)) !== null;
  // Dictation and a voice conversation both need the microphone.
  const voiceConversationLive = voicePhase !== "idle";
  const voiceInput = useVoiceInputController({
    ownerKey: composerDraftKey,
    label: props.selectedThread.title || "Untitled thread",
    readDraftMessage: () => getComposerDraftSnapshot(composerDraftKey).text,
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(composerDraftsAtom, onChange),
    selection: composerMenu.selection,
    disabled: voiceConversationLive,
    onChangeDraftMessage: (text) => setComposerDraftText(composerDraftKey, text),
    onChangeSelection: composerMenu.onSelectionChange,
  });
  const offersVoiceConversation =
    voiceModeSupported && selectedProviderStatus?.supportsVoice === true;
  const canToggleVoiceConversation =
    voiceConversationLive ||
    (props.connectionState === "connected" && threadOnServer && !voiceInput.isBusy);
  const toggleVoiceConversation = useCallback(() => voiceMode.toggle(voiceTarget), [voiceTarget]);
  const voiceModeButton = props.isDraft ? (
    props.draftVoice ? (
      <ComposerVoiceModeButton
        phase="idle"
        disabled={!props.draftVoice.canStart || voiceInput.isBusy}
        onPress={props.draftVoice.start}
      />
    ) : null
  ) : offersVoiceConversation ? (
    <ComposerVoiceModeButton
      phase={voicePhase}
      disabled={!canToggleVoiceConversation}
      onPress={toggleVoiceConversation}
    />
  ) : null;
  const isSubmissionLocked =
    props.interactionLocked === true || queuedEdit?.saving === true || voiceInput.blocksSubmission;
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const isVoiceInputPresented = voicePresentation.statusLabel !== null;
  // An open draft stays visible; only a collapsed composer becomes a voice strip.
  const isExpanded =
    isFocused || settingsSheetPresentation.keepsComposerExpanded || fullScreenEditor.fullScreen;
  const { height: windowHeight } = useWindowDimensions();
  const keyboardHeight = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const safeAreaInsets = useSafeAreaInsets();
  const editorMaxHeight = expandedEditorMaxHeight({
    windowHeight,
    keyboardHeight,
    topInset: safeAreaInsets.top,
    bottomInset: props.bottomInset ?? 0,
  });
  // Full screen gives the editor the thread's glimpse too: only the header and tabs stay above.
  // A resting composer sits the safe-area inset higher than the cap allows for.
  // Sidebar fork: the estimate misses the real header and chrome heights, so once open the
  // composer measures where its top landed and grows by the gap left below the header. The
  // miss does not depend on the keyboard, so the fit settles once per opening and is not
  // redone mid-way through a keyboard animation.
  const composerRootRef = useRef<ViewInstance>(null);
  const [fullScreenCorrection, setFullScreenCorrection] = useState(0);
  const fullScreenFittedRef = useRef(false);
  useEffect(() => {
    if (!fullScreenEditor.fullScreen) fullScreenFittedRef.current = false;
  }, [fullScreenEditor.fullScreen]);
  const fullScreenEditorHeight =
    editorMaxHeight +
    COMPOSER_FULL_SCREEN_EXTRA_HEIGHT -
    (keyboardHeight > 0 ? 0 : safeAreaInsets.bottom) +
    fullScreenCorrection;
  const fullScreenTop = props.fullScreenTop ?? null;
  const fitFullScreenToHeader = () => {
    if (!fullScreenEditor.fullScreen || fullScreenTop === null || fullScreenFittedRef.current) {
      return;
    }
    composerRootRef.current?.measureInWindow((_x, y) => {
      const gap = Math.round(y - fullScreenTop);
      if (Math.abs(gap) > 1) setFullScreenCorrection((current) => current + gap);
      else fullScreenFittedRef.current = true;
    });
  };
  const { setComposerEditing } = useAdaptiveWorkspaceLayout();
  const lineHeight = bodyText.lineHeight;
  // Sidebar fork: the composer keeps sidebar.43's layout instead of upstream's one-row
  // composer. A focused composer is a card with the draft above a toolbar row, so the
  // model name and its reasoning effort stay in view while typing.
  const usesCard = isExpanded;
  const showsCompactDictation = isVoiceInputPresented && !usesCard;
  const isToolbarVisible = usesCard || isVoiceInputPresented;
  const hasEditingAttachments =
    (queuedEdit !== null && queuedEdit.existingAttachments.length > 0) ||
    stripAttachments.length > 0;
  const attachmentBlockReason = composerAttachmentUploadBlockReason({
    environmentId: props.environmentId,
    attachments: draftAttachments,
    connected: props.connectionState === "connected",
    serverConfig: props.serverConfig,
    states: uploadStates,
  });
  const contextImports = useAtomValue(composerContextImportsAtom);
  const sendBlockedReason =
    (queuedEdit?.saving === true ? "Saving…" : null) ??
    props.sendBlockedReason ??
    (pendingPastedTextAttachmentCount > 0 ? "Attaching pasted text" : null) ??
    attachmentBlockReason;
  const canSend =
    (props.canOperateThread || props.connectionState !== "connected") &&
    hasContent &&
    !contextImports[composerDraftKey] &&
    !isSubmissionLocked &&
    sendBlockedReason === null &&
    !modelUnavailable;

  useEffect(() => () => setComposerEditing(false), [setComposerEditing]);

  const onPressPreview = (source: FilePreviewSource) => {
    wasExpandedBeforePreviewRef.current = isFocused;
    setPreviewVideo(null);
    setPreviewFile(
      (current) =>
        current ?? {
          ...source,
          gallery: filePreviewGallery(source, composerImageGallery(draftAttachments)),
        },
    );
  };

  const closePreview = () => {
    setPreviewFile(null);
    setPreviewVideo(null);
    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => {
        if (navigation.isFocused()) inputRef.current?.focus();
      }, 100);
    }
  };

  const onPressVideo = (attachment: DraftComposerFileAttachment, sourceIdentifier: string) => {
    wasExpandedBeforePreviewRef.current = isFocused;
    setPreviewFile(null);
    setPreviewVideo((current) => current ?? { type: "local", attachment, sourceIdentifier });
  };

  const onEditorFocusChange = props.onEditorFocusChange;
  const handleFocus = () => {
    setIsFocused(true);
    onEditorFocusChange?.(true);
    setComposerEditing(true);
  };

  const handleBlur = () => {
    setIsFocused(false);
    onEditorFocusChange?.(false);
    setComposerEditing(false);
  };
  const handleSend = async (followUp?: ActiveTurnComposerAction) => {
    if (
      isSubmissionLocked ||
      sendBlockedReason !== null ||
      pendingPastedTextAttachmentCountRef.current > 0 ||
      pendingNativeImagePasteCountRef.current > 0
    )
      return;
    if (usageLimitsOffered && isUsageLimitsCommand(draftMessage) && draftAttachments.length === 0) {
      if (openUsageLimits()) onChangeDraftMessage("");
      return;
    }
    const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
    if (inFlightThreadIdsRef.current.has(threadKey)) return;
    inFlightThreadIdsRef.current.add(threadKey);
    const draftAtSend = getComposerDraftSnapshot(composerDraftKey);
    const stillSendable = () => {
      const draft = getComposerDraftSnapshot(composerDraftKey);
      return (
        pendingPastedTextAttachmentCountRef.current === 0 &&
        pendingNativeImagePasteCountRef.current === 0 &&
        draft.text === draftAtSend.text &&
        draft.attachments.length === draftAtSend.attachments.length &&
        draft.attachments.every(
          (attachment, index) => attachment.id === draftAtSend.attachments[index]?.id,
        )
      );
    };
    const sent = await settlePromise(() => onSendMessage(followUp, stillSendable));
    inFlightThreadIdsRef.current.delete(threadKey);
    if (AsyncResult.isFailure(sent)) {
      // The composer state already surfaces send errors; only the lock needed releasing.
      console.error("[composer] send failed", squashAtomCommandFailure(sent));
      return;
    }
    if (sent.value === null) return;
    fullScreenEditor.close();
    // Armed after the send so its preference read and native Activity start don't contend
    // with the queued-message feedback on the tap frame.
    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: props.environmentId,
      threadTitle: props.selectedThread.title,
      projectTitle: props.environmentLabel ?? "T3 Code",
    });
  };

  const lockedProviderInstanceId = props.canSwitchProvider
    ? undefined
    : currentModelSelection.instanceId;
  const modelOptions = buildModelOptions(
    props.serverConfig,
    currentModelSelection,
    lockedProviderInstanceId,
    props.selectedThread.projectId,
  );
  const threadProviderGroups = groupByProvider(modelOptions);
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null;
  const currentModelDisplay = currentModelOption
    ? modelOptionDisplay(currentModelOption)
    : resolveModelDisplay({ name: formatModelSlugName(currentModelSelection.model) });
  const providerOptionDescriptors = resolveProviderOptionDescriptors({
    capabilities: currentModelOption?.capabilities,
    selections: currentModelSelection.options,
  });
  const settingsOwnerId = composerOwnerKey;
  const settingsRouteSession = {
    ownerId: settingsOwnerId,
    environmentId: props.environmentId,
    projectId: props.selectedThread.projectId,
    providerInstanceId: currentModelSelection.instanceId,
    ...(lockedProviderInstanceId ? { lockedProviderInstanceId } : {}),
    providerGroups: threadProviderGroups,
    selectedModel: currentModelSelection,
    prompt: draftMessage,
    onPromptChange: (text) => setComposerDraftText(composerDraftKey, text),
    reportedModelSelection: props.reportedModelSelection,
    onSelectModel: (option) =>
      props.onUpdateModelSelection(withRememberedModelOptions(option.selection)),
    restoreSelection: withRememberedModelOptions,
    optionDescriptors: providerOptionDescriptors,
    onUpdateOptionSelections: (options) => {
      rememberModelOptions(
        currentModelSelection.instanceId,
        currentModelSelection.model,
        options ?? [],
      );
      props.onUpdateModelSelection({ ...currentModelSelection, options });
    },
    runtimeMode: currentRuntimeMode,
    onUpdateRuntimeMode: props.onUpdateRuntimeMode,
  } satisfies ExistingThreadSettingsRouteSession;
  const openSettings = () => {
    settingsRoutePresentation.present(settingsRouteSession);
    settingsSheetPresentation.open();
  };
  // The quick sheet is an in-app overlay, so it keeps the thread visible and
  // applies a picked model immediately. "All models" hands off to the native
  // catalog route, which still owns search, providers and legacy models.
  const [isQuickModelSheetOpen, setQuickModelSheetOpen] = useState(false);
  const restoreFocusAfterQuickSheetRef = useRef(false);
  const openQuickModelSheet = () => {
    restoreFocusAfterQuickSheetRef.current = isFocused;
    Keyboard.dismiss();
    inputRef.current?.blur();
    setQuickModelSheetOpen(true);
  };
  const closeQuickModelSheet = () => {
    setQuickModelSheetOpen(false);
    if (!restoreFocusAfterQuickSheetRef.current) return;
    restoreFocusAfterQuickSheetRef.current = false;
    setTimeout(() => inputRef.current?.focus(), 120);
  };
  const openAllModels = () => {
    setQuickModelSheetOpen(false);
    restoreFocusAfterQuickSheetRef.current = false;
    requestAnimationFrame(openSettings);
  };

  useEffect(() => {
    if (settingsSheetPresentation.isActive) {
      settingsRoutePresentation.present(settingsRouteSession);
    }
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.isActive]);

  useEffect(() => {
    if (!settingsSheetPresentation.isVisible || settingsRoutePresentedRef.current) {
      return;
    }

    settingsRoutePresentedRef.current = true;
    navigation.dispatch(StackActions.push("ThreadSettingsSheet"));
  }, [navigation, settingsSheetPresentation.isVisible]);

  useFocusEffect(() => {
    if (!settingsRoutePresentedRef.current) {
      return;
    }

    settingsRoutePresentedRef.current = false;
    settingsSheetPresentation.onDismissed();
    settingsRoutePresentation.clear(settingsOwnerId);
  });

  useEffect(
    () =>
      // UIKit's completion callback for the sheet dismissal, surfaced by the
      // native-stack patch. This is when the queued keyboard restore runs.
      (navigation as unknown as NavigationWithFinishTransitioning).addListener(
        "finishTransitioning",
        settingsSheetPresentation.onStackTransitionsFinished,
      ),
    [navigation, settingsSheetPresentation.onStackTransitionsFinished],
  );

  // Removable attachments: inside the card, or above the focused one-row composer.
  const editingAttachments = hasEditingAttachments ? (
    <>
      {queuedEdit !== null && queuedEdit.existingAttachments.length > 0 ? (
        <Animated.View
          className="px-[14px] pb-2.5 pt-2"
          entering={COMPOSER_ATTACHMENT_ENTERING}
          exiting={FadeOut.duration(120)}
        >
          <ComposerQueuedEditAttachments
            environmentId={props.environmentId}
            attachments={queuedEdit.existingAttachments}
            disabled={isSubmissionLocked}
            onRemove={queuedEdit.onRemoveExistingAttachment}
          />
        </Animated.View>
      ) : null}
      {stripAttachments.length > 0 ? (
        <Animated.View
          className="px-[14px] pb-2.5 pt-2"
          entering={COMPOSER_ATTACHMENT_ENTERING}
          exiting={FadeOut.duration(120)}
        >
          <ComposerAttachmentStrip
            environmentId={props.environmentId}
            attachments={stripAttachments}
            onRemove={isSubmissionLocked ? () => undefined : props.onRemoveDraftImage}
            onPressPreview={isSubmissionLocked ? undefined : onPressPreview}
            onPressVideo={isSubmissionLocked ? undefined : onPressVideo}
            onPressDocument={
              isSubmissionLocked
                ? undefined
                : (attachment) =>
                    openDraftDocument({
                      attachmentId: attachment.id,
                      name: attachment.name,
                      mimeType: attachment.mimeType,
                      sizeBytes: attachment.sizeBytes,
                    })
            }
          />
        </Animated.View>
      ) : null}
    </>
  ) : null;

  // The row and the card's toolbar share this picker; it always names the model and its effort.
  const currentModelBadge = currentModelOption?.providerBadge;
  const modelControl = (
    <View className="min-w-0 shrink">
      <ComposerInlineControl
        accessibilityLabel={
          currentModelDisplay.effort
            ? `Model: ${currentModelDisplay.name}, reasoning ${currentModelDisplay.effort}`
            : `Model: ${currentModelDisplay.name}`
        }
        detail={currentModelDisplay.effort}
        emphasized
        renderIcon={(size) =>
          currentModelBadge?.showBadge ? (
            <ProviderInstanceIcon
              iconUrl={currentModelOption?.providerIconUrl}
              provider={currentModelOption?.providerDriver}
              displayName={currentModelBadge.displayName}
              accentColor={currentModelBadge.accentColor}
              showBadge
              surfaceColor={composerPanel}
              size={size}
            />
          ) : (
            <ProviderIcon
              iconUrl={currentModelOption?.providerIconUrl}
              provider={currentModelOption?.providerDriver}
              size={size}
            />
          )
        }
        label={currentModelDisplay.name}
        maxWidth="100%"
        onPress={openQuickModelSheet}
      />
    </View>
  );

  return (
    <Animated.View
      ref={composerRootRef}
      onLayout={(event) => {
        fitFullScreenToHeader();
        props.onHeightChange?.(event.nativeEvent.layout.height);
      }}
      className="px-[6px]"
      style={{
        paddingTop: 6,
        paddingBottom: (props.bottomInset ?? 0) + THREAD_COMPOSER_BOTTOM_GUTTER,
        backgroundColor:
          Platform.OS === "android" ? themeColorWithAlpha(composerPanel, 1) : undefined,
      }}
    >
      {/* The backdrop gradient lives on a plain View: Reanimated's Animated.View
          silently drops experimental_backgroundImage on Android, which left this
          strip fully transparent and the feed text legible through the composer. */}
      <View
        className={
          Platform.OS === "android"
            ? "hidden"
            : "absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        }
        pointerEvents="none"
      />
      <Animated.View
        className="relative w-full self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {!isSubmissionLocked &&
        composerMenu.trigger &&
        (composerMenu.items.length > 0 || composerMenu.trigger.kind === "pull-request") ? (
          <ComposerPopoverAnchor>
            <ComposerCommandPopover
              items={composerMenu.items}
              triggerKind={composerMenu.trigger.kind}
              isLoading={composerMenu.isLoading}
              error={composerMenu.error}
              onSelect={composerMenu.onSelect}
            />
          </ComposerPopoverAnchor>
        ) : null}

        {selectedProviderStatus?.compatibilityAdvisory?.message &&
        (selectedProviderStatus.compatibilityAdvisory.status === "unsupported" ||
          selectedProviderStatus.compatibilityAdvisory.status === "broken") ? (
          <Text
            accessibilityRole={
              selectedProviderStatus.compatibilityAdvisory.status === "broken" ? "alert" : undefined
            }
            accessibilityLiveRegion={
              selectedProviderStatus.compatibilityAdvisory.status === "broken"
                ? "assertive"
                : "polite"
            }
            className={
              selectedProviderStatus.compatibilityAdvisory.status === "broken"
                ? "bg-danger px-3 py-2 text-xs text-danger-foreground"
                : "px-3 py-2 text-xs text-foreground"
            }
          >
            {selectedProviderStatus.compatibilityAdvisory.message}
          </Text>
        ) : null}

        {voiceConversationLive ? (
          <ComposerVoiceStrip />
        ) : (
          <ComposerVoiceElsewhereStrip
            onTalkHere={
              offersVoiceConversation && canToggleVoiceConversation
                ? toggleVoiceConversation
                : undefined
            }
          />
        )}

        {modelUnavailable ? (
          <Button
            label="Model unavailable. Open model settings."
            tone="text"
            onPress={openSettings}
          />
        ) : null}

        <ComposerSurface
          style={
            usesCard
              ? {
                  borderRadius: 26,
                  overflow: "hidden" as const,
                  paddingBottom: 0,
                  paddingTop: 10,
                }
              : {
                  borderRadius: 27,
                  overflow: "hidden" as const,
                  paddingVertical: 2,
                }
          }
        >
          {isExpanded && !usesCard ? editingAttachments : null}
          <ComposerDictationDraftContent
            className={usesCard ? undefined : "flex-row items-center"}
            compact={!usesCard}
            hidden={showsCompactDictation}
          >
            {!usesCard ? (
              <ComposerAttachmentButton
                disabled={isSubmissionLocked}
                supportsFiles={Boolean(
                  props.serverConfig?.environment.capabilities.fileAttachments,
                )}
                onPickMedia={props.onPickDraftMedia}
                onPickFiles={props.onPickDraftFiles}
              />
            ) : null}
            {fullScreenEditor.fullScreen ? (
              <View className="absolute right-1 top-0 z-10">
                <ComposerFullScreenButton fullScreen onPress={fullScreenEditor.close} />
              </View>
            ) : null}
            {usesCard && !fullScreenEditor.fullScreen ? editingAttachments : null}
            <Animated.View
              className={usesCard ? "px-[14px]" : "min-w-0 flex-1 px-[4px]"}
              style={usesCard ? undefined : { minWidth: INLINE_EDITOR_MIN_WIDTH }}
              layout={COMPOSER_LAYOUT_TRANSITION}
            >
              <ComposerEditor
                hidden={props.hidden}
                draftKey={composerDraftKey}
                environmentId={props.environmentId}
                onOpenMention={(path) => {
                  Keyboard.dismiss();
                  if (props.isDraft) {
                    navigation.navigate("NewTaskFile", {
                      environmentId: String(props.environmentId),
                      cwd: props.projectCwd ?? undefined,
                      path: fileRoutePathSegments(path),
                    });
                  } else {
                    navigation.navigate("ThreadFile", {
                      environmentId: String(props.environmentId),
                      threadId: String(props.selectedThread.id),
                      path: fileRoutePathSegments(path),
                    });
                  }
                }}
                onOpenAttachment={openDraftDocument}
                chipsInert={!isExpanded}
                onInertChipPress={() => inputRef.current?.focus()}
                ref={inputRef}
                multiline
                value={draftMessage}
                // The save uses a draft snapshot; further typing would be discarded on success.
                readOnly={isSubmissionLocked}
                skills={composerMenu.skills}
                selection={composerMenu.selection}
                onChangeText={(text) => {
                  if (!isSubmissionLocked) props.onChangeDraftMessage(text);
                }}
                onSelectionChange={composerMenu.onSelectionChange}
                onPasteImages={(uris) => {
                  if (isSubmissionLocked) return;
                  pendingNativeImagePasteCountRef.current += 1;
                  void props.onNativePasteImages(uris).finally(() => {
                    pendingNativeImagePasteCountRef.current -= 1;
                  });
                }}
                onPasteText={(paste) => {
                  if (isSubmissionLocked) return;
                  const insertPaste = () => {
                    const insertion = replaceTextSelection({
                      value: paste.value,
                      selection: paste.selection,
                      text: paste.text,
                    });
                    const selection = { start: insertion.cursor, end: insertion.cursor };
                    props.onChangeDraftMessage(insertion.value);
                    composerMenu.onSelectionChange(selection);
                  };
                  const capabilities = props.serverConfig?.environment.capabilities;
                  const advertisedMax =
                    capabilities?.attachmentUploads === true
                      ? capabilities.fileAttachments?.maxUploadBytes
                      : undefined;
                  const maxBytes =
                    advertisedMax === undefined
                      ? null
                      : clampFileAttachmentUploadBytes(advertisedMax);
                  const wouldExceedInputLimit =
                    paste.value.length -
                      Math.max(0, paste.selection.end - paste.selection.start) +
                      paste.text.length >
                    PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
                  const canAttach =
                    maxBytes !== null &&
                    countComposerDraftAttachmentsAfterSelection(composerDraftKey, {
                      text: paste.value,
                      ...paste.selection,
                    }) < PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
                    new TextEncoder().encode(paste.text).byteLength <= maxBytes;
                  if (
                    pastedTextDisposition({
                      text: paste.text,
                      wouldExceedInputLimit,
                      canAttach: true,
                    }) === "attachment"
                  ) {
                    if (canAttach) {
                      pendingPastedTextAttachmentCountRef.current += 1;
                      setPendingPastedTextAttachmentCount(
                        pendingPastedTextAttachmentCountRef.current,
                      );
                      const finishAttachment = () => {
                        pendingPastedTextAttachmentCountRef.current = Math.max(
                          0,
                          pendingPastedTextAttachmentCountRef.current - 1,
                        );
                        setPendingPastedTextAttachmentCount(
                          pendingPastedTextAttachmentCountRef.current,
                        );
                      };
                      void props.onNativePasteText(paste).then(finishAttachment, finishAttachment);
                    } else if (!wouldExceedInputLimit) {
                      insertPaste();
                    } else {
                      Dialog.alert(
                        wouldExceedInputLimit
                          ? "Pasted text is too large for this message"
                          : "Could not attach pasted text",
                        wouldExceedInputLimit
                          ? "Remove some text or an attachment, then paste again."
                          : "Remove an attachment or use a smaller paste, then try again.",
                      );
                    }
                    return;
                  }
                  insertPaste();
                }}
                placeholder={props.placeholder}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onContentHeightChange={fullScreenEditor.onContentHeightChange}
                onSubmit={(alternate) =>
                  void handleSend(
                    alternate && sendPresentation.alternate !== null
                      ? sendPresentation.alternate
                      : undefined,
                  )
                }
                submitTitle={sendPresentation.label}
                alternateSubmitTitle={
                  sendPresentation.alternate === null
                    ? sendPresentation.label
                    : FOLLOW_UP_ACTION_LABEL[sendPresentation.alternate]
                }
                scrollEnabled={isExpanded}
                singleLineCentered={!usesCard}
                contentInsetVertical={
                  usesCard || Platform.OS === "android" ? 0 : collapsedEditorInset(bodyText)
                }
                style={
                  fullScreenEditor.fullScreen
                    ? {
                        minHeight: fullScreenEditorHeight,
                        maxHeight: fullScreenEditorHeight,
                        paddingVertical: 4,
                        paddingRight: 40,
                      }
                    : usesCard
                      ? {
                          // Sidebar fork: a stacked draft grows line by line up to the
                          // space above the keyboard, then scrolls.
                          minHeight: lineHeight * 2 + 8,
                          maxHeight: Math.max(lineHeight * 2 + 8, editorMaxHeight),
                          paddingVertical: 4,
                          paddingRight: 40,
                        }
                      : {
                          // Large text sizes need room for one full line plus the iOS inset.
                          height: Math.max(
                            INLINE_EDITOR_HEIGHT,
                            Math.ceil(lineHeight) +
                              (Platform.OS === "android" ? 0 : 2 * collapsedEditorInset(bodyText)),
                          ),
                        }
                }
                textStyle={{
                  ...bodyText,
                  color: foregroundColor,
                }}
              />
            </Animated.View>
            {!isExpanded && stripAttachments.length > 0 ? (
              <View className="flex-row gap-1 pl-1">
                {stripAttachments.slice(0, 3).map((attachment) => (
                  <ComposerAttachmentThumbnail
                    environmentId={props.environmentId}
                    key={attachment.id}
                    attachment={attachment}
                    size={30}
                    borderRadius={8}
                    compact
                    onPressPreview={isSubmissionLocked ? undefined : onPressPreview}
                    onPressVideo={isSubmissionLocked ? undefined : onPressVideo}
                  />
                ))}
                {stripAttachments.length > 3 ? (
                  <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                    <Text className="text-foreground-muted text-2xs font-t3-bold">
                      +{stripAttachments.length - 3}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {!usesCard ? (
              <View className="min-w-0 shrink flex-row items-center">
                {modelControl}
                {voiceModeButton}
                <ComposerDictationStartAction
                  state={voiceInput.state}
                  isAvailable={voiceInput.isAvailable}
                  disabled={voiceConversationLive || isSubmissionLocked}
                  onStart={voiceInput.start}
                  onCancel={voiceInput.cancel}
                />
                {showStopAction ? (
                  <ComposerActionButton
                    accessibilityLabel="Stop agent"
                    icon="stop.fill"
                    variant="danger"
                    disabled={!props.canOperateThread}
                    onPress={props.onStopThread}
                  />
                ) : showResumeAction ? (
                  <ComposerActionButton
                    accessibilityLabel="Resume queue"
                    icon="play"
                    disabled={!props.canOperateThread || resumingQueue}
                    onPress={() => void handleResumeQueue()}
                  />
                ) : (
                  <SendActionButton
                    accessibilityLabel={sendBlockedReason ?? sendLabel}
                    presentation={sendPresentation}
                    disabled={!canSend}
                    onSend={handleSend}
                  />
                )}
              </View>
            ) : null}
          </ComposerDictationDraftContent>
          <Animated.View
            accessibilityElementsHidden={!isToolbarVisible}
            collapsable={false}
            importantForAccessibility={isToolbarVisible ? "auto" : "no-hide-descendants"}
            layout={COMPOSER_LAYOUT_TRANSITION}
            pointerEvents={isToolbarVisible ? "auto" : "none"}
            style={
              usesCard
                ? undefined
                : {
                    position: "absolute",
                    bottom: 2,
                    left: 0,
                    right: 0,
                  }
            }
          >
            <ComposerDictationToolbar
              showsDictation={isVoiceInputPresented}
              visible={isToolbarVisible}
            >
              <ComposerToolbarRow
                paddingBottom={0}
                paddingHorizontal={0}
                paddingTop={0}
                style={{ gap: 0 }}
              >
                <ComposerDictationCancelAction
                  presentation={voicePresentation}
                  onCancel={voiceInput.cancel}
                />
                {isVoiceInputPresented ? (
                  <ComposerDictationStatus
                    audioLevels={voiceInput.audioLevels}
                    elapsedSeconds={voiceInput.elapsedSeconds}
                    phase={voiceInput.state.phase}
                    presentation={voicePresentation}
                    onDismissError={voiceInput.cancel}
                  />
                ) : (
                  <View className="min-w-0 flex-1 flex-row items-center justify-between">
                    {fullScreenEditor.fullScreen ? (
                      <View />
                    ) : (
                      <ComposerAttachmentButton
                        disabled={isSubmissionLocked}
                        supportsFiles={Boolean(
                          props.serverConfig?.environment.capabilities.fileAttachments,
                        )}
                        onPickMedia={props.onPickDraftMedia}
                        onPickFiles={props.onPickDraftFiles}
                      />
                    )}
                    {fullScreenEditor.offersFullScreen && !fullScreenEditor.fullScreen ? (
                      <ComposerFullScreenButton
                        fullScreen={false}
                        onPress={fullScreenEditor.open}
                      />
                    ) : null}
                    {fullScreenEditor.fullScreen ? null : modelControl}
                  </View>
                )}
                <View className="shrink-0 flex-row items-center">
                  {isVoiceInputPresented || fullScreenEditor.fullScreen ? null : voiceModeButton}
                  {fullScreenEditor.fullScreen && !isVoiceInputPresented ? null : (
                    <ComposerDictationPrimaryAction
                      state={voiceInput.state}
                      presentation={voicePresentation}
                      isAvailable={voiceInput.isAvailable}
                      disabled={voiceConversationLive || isSubmissionLocked}
                      onStart={voiceInput.start}
                      onConfirm={voiceInput.stop}
                      onCancel={voiceInput.cancel}
                    />
                  )}
                  {showStopAction ? (
                    <ComposerActionButton
                      accessibilityLabel="Stop agent"
                      icon="stop.fill"
                      variant="danger"
                      disabled={!props.canOperateThread}
                      onPress={props.onStopThread}
                    />
                  ) : showResumeAction && voicePresentation.showsSend ? (
                    <ComposerActionButton
                      accessibilityLabel="Resume queue"
                      icon="play"
                      disabled={!props.canOperateThread || resumingQueue}
                      onPress={() => void handleResumeQueue()}
                    />
                  ) : voicePresentation.showsSend ? (
                    <SendActionButton
                      accessibilityLabel={sendBlockedReason ?? sendLabel}
                      presentation={sendPresentation}
                      disabled={!canSend}
                      onSend={handleSend}
                    />
                  ) : null}
                </View>
              </ComposerToolbarRow>
            </ComposerDictationToolbar>
          </Animated.View>
        </ComposerSurface>

        {props.connectionState === "connected" && !props.canOperateThread ? (
          <Text className="pt-2 text-xs text-foreground-muted">
            This connection cannot control this task. You can still edit your draft.
          </Text>
        ) : null}
      </Animated.View>

      {isQuickModelSheetOpen ? (
        <QuickModelSheet
          {...settingsRouteSession}
          onClose={closeQuickModelSheet}
          onOpenAllModels={openAllModels}
        />
      ) : null}
      <VideoPreviewModal source={previewVideo} onRequestClose={closePreview} />
      <FilePreviewModal source={previewFile} onRequestClose={closePreview} />
    </Animated.View>
  );
};
