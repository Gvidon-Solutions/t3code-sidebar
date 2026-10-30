import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  InboxIssueId,
  ThreadId,
  type InboxEntry,
  type InboxIssue,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { PullRequestMarkdown } from "../pull-requests/PullRequestMarkdown";
import {
  isFileAttachment,
  isImageAttachment,
  MessageAttachmentFile,
  MessageAttachmentImage,
  MessageAttachmentUnknown,
} from "../threads/ThreadFeed";
import { InboxComposer } from "./InboxComposer";
import {
  INBOX_SEVERITY_DOT,
  INBOX_SEVERITY_LABELS,
  failedInboxDeliveries,
  presentInboxEntry,
} from "./inboxList";
import { inboxEnvironment } from "./useInbox";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

type InboxIssueParams = { readonly environmentId: string; readonly issueId: string };

/** Fork: one inbox issue, its history and the owner's reply box. */
export function InboxIssueRouteScreen({ route }: StaticScreenProps<InboxIssueParams>) {
  return (
    <InboxIssueScreen
      key={`${route.params.environmentId}:${route.params.issueId}`}
      environmentId={EnvironmentId.make(route.params.environmentId)}
      issueId={InboxIssueId.make(route.params.issueId)}
    />
  );
}

/** Opens history attachments the way a thread's messages do. */
interface AttachmentPreview {
  readonly onPressPreview: (source: FilePreviewSource) => void;
}

const noop = () => {};

function InboxIssueScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly issueId: InboxIssueId;
}) {
  const { environmentId, issueId } = props;
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const bottomInset = keyboardVisible ? 8 : Math.max(insets.bottom, 12);
  const detail = useEnvironmentQuery(
    inboxEnvironment.inboxIssueLive({ environmentId, input: { issueId } }),
  );
  const environmentLabel =
    useWorkspaceEnvironments().find((environment) => environment.environmentId === environmentId)
      ?.environmentLabel ?? null;
  const canOperate = useAtomValue(inboxEnvironment.commentOnIssue.permissionAtom(environmentId));
  const dismiss = useAtomCommand(inboxEnvironment.dismissIssue);
  const undismiss = useAtomCommand(inboxEnvironment.undismissIssue);
  const markSeen = useAtomCommand(inboxEnvironment.markIssueSeen, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [composerHeight, setComposerHeight] = useState(64);
  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const issue = detail.data?.issue ?? null;
  const entries = detail.data?.entries ?? [];

  // Reading is not answering: seeing the issue only moves the seen marker.
  const focused = useIsFocused();
  const requestedSeen = useRef(0);
  const lastSequence = issue?.lastSequence ?? 0;
  const seenSequence = issue?.seenSequence ?? 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- marks the issue seen on the server while the screen is focused
  useEffect(() => {
    if (!focused || !canOperate || lastSequence <= seenSequence) return;
    if (requestedSeen.current >= lastSequence) return;
    requestedSeen.current = lastSequence;
    void markSeen({ environmentId, input: { issueId, sequence: lastSequence } });
  }, [canOperate, environmentId, focused, issueId, lastSequence, markSeen, seenSequence]);

  const closeAsNotRelevant = () =>
    Dialog.prompt({
      title: "Close as not relevant",
      initialValue: "",
      confirmText: "Close issue",
      onConfirm: (value) => {
        const reason = value.trim();
        if (!reason) return;
        setBusy(true);
        void dismiss({ environmentId, input: { issueId, reason } }).finally(() => setBusy(false));
      },
    });
  const reopen = () => {
    setBusy(true);
    void undismiss({ environmentId, input: { issueId } }).finally(() => setBusy(false));
  };
  const openThread = (threadId: ThreadId) =>
    selectDetail({
      name: "Thread",
      params: {
        environmentId: String(environmentId),
        threadId: String(threadId),
      },
    });
  const onPressPreview = useCallback((source: FilePreviewSource) => {
    setPreviewFile((current) => current ?? source);
  }, []);
  const preview: AttachmentPreview = { onPressPreview };

  const showComposer = canOperate && issue !== null;
  return (
    <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1 bg-screen">
      {/* The title reads in full in the body, as in a mail app; the bar only carries the machine. */}
      <NativeStackScreenOptions options={{ title: environmentLabel ?? "Issue" }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={environmentLabel ?? "Issue"}
          onBack={() => navigation.goBack()}
        />
      ) : null}
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: showComposer ? composerHeight + 24 : bottomInset + 24,
        }}
      >
        {issue === null ? (
          detail.error ? (
            <Text selectable className="py-8 text-center text-sm text-foreground-muted">
              {detail.error}
            </Text>
          ) : (
            <View className="items-center py-16">
              <AppActivityIndicator colorClassName="accent-icon" />
            </View>
          )
        ) : (
          <>
            <IssueHeader
              issue={issue}
              environmentId={environmentId}
              canOperate={canOperate}
              busy={busy}
              onOpenThread={openThread}
              onClose={closeAsNotRelevant}
              onReopen={reopen}
            />
            {issue.description.trim() ? (
              <View className="pt-4">
                <PullRequestMarkdown markdown={issue.description} />
              </View>
            ) : null}
            {entries.length > 0 ? (
              <View className="flex-row items-center gap-3 pb-3 pt-7">
                <Text className="text-xs font-t3-medium text-foreground-muted">Activity</Text>
                <View className="h-px flex-1 bg-border" />
              </View>
            ) : null}
            {entries.map((entry) => (
              <IssueEntry
                key={entry.id}
                entry={entry}
                environmentId={environmentId}
                preview={preview}
                onOpenThread={openThread}
              />
            ))}
          </>
        )}
      </ScrollView>
      {showComposer ? (
        <InboxComposer
          environmentId={environmentId}
          issueId={issueId}
          waitingForOwner={issue.state === "open" && issue.waitingForOwner}
          startsConversation={issue.responsibleThreadId === null}
          bottomInset={bottomInset}
          onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
        />
      ) : null}
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
    </KeyboardAvoidingView>
  );
}

const CLOSE_ACTIONS: MenuAction[] = [
  {
    id: "close",
    title: "Close as not relevant",
    image: "nosign",
    attributes: { destructive: true },
  },
];

function IssueHeader(props: {
  readonly issue: InboxIssue;
  readonly environmentId: EnvironmentId;
  readonly canOperate: boolean;
  readonly busy: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onClose: () => void;
  readonly onReopen: () => void;
}) {
  const { issue } = props;
  const open = issue.state === "open";
  const responsible = issue.responsibleThreadId;
  const otherThreads = issue.threadIds.filter((threadId) => threadId !== responsible);
  const eyebrow = [
    issue.source.label,
    issue.repeatCount > 0 ? `Reported ${issue.repeatCount + 1} times` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View className="gap-2.5">
      <View className="flex-row flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <View className={cn("size-1.5 rounded-full", INBOX_SEVERITY_DOT[issue.severity])} />
        <Text className="text-xs font-t3-medium text-foreground-secondary">
          {INBOX_SEVERITY_LABELS[issue.severity]}
        </Text>
        {eyebrow ? (
          <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
            · {eyebrow}
          </Text>
        ) : null}
      </View>
      <Text
        selectable
        className={cn(
          "text-[22px] font-t3-bold leading-[28px]",
          open ? "text-foreground" : "text-foreground-secondary",
        )}
      >
        {issue.title}
      </Text>
      <IssueStatus
        issue={issue}
        canOperate={props.canOperate}
        busy={props.busy}
        onReopen={props.onReopen}
      />
      {otherThreads.length > 0 ? (
        <View className="flex-row flex-wrap items-center gap-x-2">
          <Text className="text-xs text-foreground-muted">Also worked on in</Text>
          {otherThreads.map((threadId) => (
            <ThreadLink
              key={threadId}
              environmentId={props.environmentId}
              threadId={threadId}
              onPress={props.onOpenThread}
            />
          ))}
        </View>
      ) : null}
      {responsible !== null || (props.canOperate && open) ? (
        <View className="flex-row items-center gap-2 pt-1">
          {responsible !== null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open the agent's conversation"
              onPress={() => props.onOpenThread(responsible)}
              className="h-9 flex-row items-center gap-1.5 rounded-full border border-border px-3.5 active:bg-subtle"
            >
              <SymbolView
                name="bubble.left.and.bubble.right"
                size={14}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
              <Text className="text-sm font-t3-medium text-foreground">Conversation</Text>
            </Pressable>
          ) : null}
          {props.canOperate && open ? (
            <Menu
              accessibilityLabel="More actions"
              actions={CLOSE_ACTIONS}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "close" && !props.busy) props.onClose();
              }}
            >
              <View className="size-9 items-center justify-center rounded-full border border-border">
                <SymbolView
                  name="ellipsis"
                  size={15}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              </View>
            </Menu>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A closed issue says how it ended in one quiet line; resolved is the one green outcome. */
function IssueStatus(props: {
  readonly issue: InboxIssue;
  readonly canOperate: boolean;
  readonly busy: boolean;
  readonly onReopen: () => void;
}) {
  const { issue } = props;
  const ago = issue.closedAt ? ` · ${relativeTime(issue.closedAt)}` : "";
  if (issue.state === "resolved") {
    return (
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name="checkmark.circle"
          size={15}
          tintColorClassName="accent-adaptive-emerald-600-400"
          type="monochrome"
        />
        <Text className="text-sm font-t3-medium text-adaptive-emerald-700-300">
          Resolved by the agent
          <Text className="text-sm font-sans text-foreground-muted">{ago}</Text>
        </Text>
      </View>
    );
  }
  if (issue.state === "dismissed") {
    return (
      <View className="flex-row flex-wrap items-center gap-1.5">
        <SymbolView
          name="nosign"
          size={14}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        <Text className="text-sm text-foreground-secondary">
          Closed as not relevant
          <Text className="text-sm text-foreground-muted">{ago}</Text>
        </Text>
        {props.canOperate ? (
          <Pressable
            accessibilityRole="button"
            disabled={props.busy}
            hitSlop={8}
            onPress={props.onReopen}
            className="active:opacity-60"
          >
            <Text className="text-sm font-t3-medium text-primary-text">· Reopen</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  return null;
}

function ThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onPress: (threadId: ThreadId) => void;
}) {
  const thread = useThreadShell({ environmentId: props.environmentId, threadId: props.threadId });
  return (
    <Text
      accessibilityRole="link"
      onPress={() => props.onPress(props.threadId)}
      numberOfLines={1}
      className="py-0.5 text-xs font-t3-medium text-primary-text"
    >
      {thread?.title ?? "Untitled thread"}
    </Text>
  );
}

function EntryAttachments(props: {
  readonly entry: InboxEntry;
  readonly environmentId: EnvironmentId;
  readonly preview: AttachmentPreview;
}) {
  const attachments = props.entry.attachments ?? [];
  if (attachments.length === 0) return null;
  return (
    <View className="gap-2">
      {attachments.map((attachment) =>
        isImageAttachment(attachment) ? (
          <MessageAttachmentImage
            key={attachment.id}
            environmentId={props.environmentId}
            attachmentId={attachment.id}
            name={attachment.name}
            mimeType={attachment.mimeType}
            className="aspect-[1.3] w-full rounded-[14px] bg-user-bubble-foreground/15"
            onPressPreview={props.preview.onPressPreview}
          />
        ) : isFileAttachment(attachment) ? (
          <MessageAttachmentFile
            key={attachment.id}
            environmentId={props.environmentId}
            attachment={attachment}
            onPressPreview={props.preview.onPressPreview}
            onPlaybackStart={noop}
          />
        ) : (
          <MessageAttachmentUnknown key={attachment.id} name={attachment.name} />
        ),
      )}
    </View>
  );
}

function AgentName(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const thread = useThreadShell(
    props.threadId === null
      ? null
      : { environmentId: props.environmentId, threadId: props.threadId },
  );
  const { threadId } = props;
  if (threadId === null || thread === null) {
    return <Text className="text-xs font-t3-medium text-foreground-secondary">Agent</Text>;
  }
  return (
    <Text
      accessibilityRole="link"
      numberOfLines={1}
      onPress={() => props.onOpenThread(threadId)}
      className="min-w-0 shrink text-xs font-t3-medium text-foreground-secondary"
    >
      {thread.title}
    </Text>
  );
}

const EVENT_ICON: Partial<Record<InboxEntry["kind"], Parameters<typeof SymbolView>[0]["name"]>> = {
  created: "circle.dashed",
  updated: "pencil",
  waiting: "questionmark.bubble",
  waiting_cleared: "bubble.left",
  reminder: "bell.badge",
  handover: "arrow.right.circle",
  reopened: "arrow.uturn.backward",
  repeated: "arrow.clockwise",
  resolved: "checkmark.circle",
  dismissed: "nosign",
  undismissed: "arrow.uturn.backward",
};

function IssueEntry(props: {
  readonly entry: InboxEntry;
  readonly environmentId: EnvironmentId;
  readonly preview: AttachmentPreview;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { entry } = props;
  const presentation = presentInboxEntry(entry);
  const failures = failedInboxDeliveries(entry);
  const time = relativeTime(entry.createdAt);
  const warnings = failures.map((failure) => (
    <View key={failure} className="flex-row items-center gap-1.5 pt-1">
      <SymbolView
        name="exclamationmark.triangle"
        size={12}
        tintColorClassName="accent-warning-foreground"
        type="monochrome"
      />
      <Text selectable className="min-w-0 shrink text-xs text-warning-foreground">
        {failure}
      </Text>
    </View>
  ));

  if (presentation.kind === "comment" && presentation.side === "owner") {
    const hasAttachments = (entry.attachments?.length ?? 0) > 0;
    return (
      <View className="mb-5 items-end">
        <View
          className={cn(
            "max-w-[85%] gap-2 rounded-[20px] bg-user-bubble px-3.5 py-2.5",
            hasAttachments && "w-[85%]",
          )}
        >
          <EntryAttachments
            entry={entry}
            environmentId={props.environmentId}
            preview={props.preview}
          />
          {presentation.text ? (
            <Text selectable className="text-base text-user-bubble-foreground">
              {presentation.text}
            </Text>
          ) : null}
        </View>
        <Text className="pr-0.5 pt-1 text-xs tabular-nums text-foreground-tertiary">
          You · {time}
        </Text>
        {warnings}
      </View>
    );
  }

  if (presentation.kind === "comment") {
    return (
      <View className="mb-5 gap-1">
        <View className="flex-row items-center gap-1.5">
          <AgentName
            environmentId={props.environmentId}
            threadId={entry.threadId}
            onOpenThread={props.onOpenThread}
          />
          <Text className="text-xs tabular-nums text-foreground-tertiary">· {time}</Text>
        </View>
        <PullRequestMarkdown markdown={presentation.text} />
        {warnings}
      </View>
    );
  }

  const resolved = entry.kind === "resolved";
  return (
    <View className="mb-3">
      <View className="flex-row items-center gap-2">
        <SymbolView
          name={EVENT_ICON[entry.kind] ?? "circle"}
          size={14}
          tintColorClassName={
            resolved ? "accent-adaptive-emerald-600-400" : "accent-foreground-tertiary"
          }
          type="monochrome"
        />
        <Text
          selectable
          className={cn(
            "min-w-0 shrink text-sm",
            resolved
              ? "font-t3-medium text-adaptive-emerald-700-300"
              : presentation.tone === "muted"
                ? "text-foreground-muted"
                : "font-t3-medium text-foreground-secondary",
          )}
        >
          {presentation.label}
        </Text>
        <Text className="text-xs tabular-nums text-foreground-tertiary">{time}</Text>
      </View>
      {presentation.detail ? (
        <View
          className={cn(
            "ml-[6px] mt-1.5 border-l-2 pl-4",
            resolved ? "border-adaptive-emerald-600-400" : "border-border",
          )}
        >
          <Text selectable className="text-sm text-foreground">
            {presentation.detail}
          </Text>
        </View>
      ) : null}
      {warnings}
    </View>
  );
}
