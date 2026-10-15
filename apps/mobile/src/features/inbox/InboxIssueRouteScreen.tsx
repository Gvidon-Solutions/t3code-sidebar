import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  InboxIssueId,
  ThreadId,
  type InboxEntry,
  type InboxIssue,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { showTextInputDialog } from "../../components/ConfirmDialogHost";
import { GlassSurface } from "../../components/GlassSurface";
import { MaterialButton } from "../../components/MaterialButton";
import { MaterialIconButton } from "../../components/MaterialIconButton";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { PullRequestMarkdown } from "../pull-requests/PullRequestMarkdown";
import { failedInboxDeliveries, INBOX_SEVERITY_LABELS, presentInboxEntry } from "./inboxList";
import { inboxEnvironment } from "./useInbox";

type InboxIssueParams = { readonly environmentId: string; readonly issueId: string };

/** Fork: one inbox issue, its history and the owner's comment composer. */
export function InboxIssueRouteScreen({ route }: StaticScreenProps<InboxIssueParams>) {
  return (
    <InboxIssueScreen
      key={`${route.params.environmentId}:${route.params.issueId}`}
      environmentId={EnvironmentId.make(route.params.environmentId)}
      issueId={InboxIssueId.make(route.params.issueId)}
    />
  );
}

function InboxIssueScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly issueId: InboxIssueId;
}) {
  const { environmentId, issueId } = props;
  const navigation = useNavigation();
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
  const comment = useAtomCommand(inboxEnvironment.commentOnIssue);
  const dismiss = useAtomCommand(inboxEnvironment.dismissIssue);
  const undismiss = useAtomCommand(inboxEnvironment.undismissIssue);
  const markSeen = useAtomCommand(inboxEnvironment.markIssueSeen, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composerHeight, setComposerHeight] = useState(64);
  const issue = detail.data?.issue ?? null;
  const entries = detail.data?.entries ?? [];

  // Reading is not answering: seeing the issue only moves the seen marker.
  const focused = useIsFocused();
  const requestedSeen = useRef(0);
  const lastSequence = issue?.lastSequence ?? 0;
  const seenSequence = issue?.seenSequence ?? 0;
  useEffect(() => {
    if (!focused || !canOperate || lastSequence <= seenSequence) return;
    if (requestedSeen.current >= lastSequence) return;
    requestedSeen.current = lastSequence;
    void markSeen({ environmentId, input: { issueId, sequence: lastSequence } });
  }, [canOperate, environmentId, focused, issueId, lastSequence, markSeen, seenSequence]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const result = await comment({ environmentId, input: { issueId, text } });
      if (result._tag === "Success")
        setDraft((current) => (current.trim() === text ? "" : current));
    } finally {
      setSending(false);
    }
  };
  const closeAsNotRelevant = () =>
    showTextInputDialog({
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
    navigation.navigate("Thread", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });

  const title = issue?.title ?? "Issue";
  return (
    <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1 bg-screen">
      <NativeStackScreenOptions
        options={{ title, unstable_headerSubtitle: environmentLabel ?? undefined }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={title}
          subtitle={environmentLabel}
          onBack={() => navigation.goBack()}
        />
      ) : null}
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: 16,
          paddingBottom: canOperate ? composerHeight + bottomInset + 24 : bottomInset + 24,
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
            <IssueSummary issue={issue} environmentLabel={environmentLabel} />
            <IssueActions
              issue={issue}
              environmentId={environmentId}
              canOperate={canOperate}
              busy={busy}
              onOpenThread={openThread}
              onClose={closeAsNotRelevant}
              onReopen={reopen}
            />
            {entries.length > 0 ? (
              <Text className="px-1 pb-2 pt-6 text-xs font-t3-medium uppercase tracking-[0.5px] text-foreground-muted">
                History
              </Text>
            ) : null}
            {entries.map((entry) => (
              <IssueEntry key={entry.id} entry={entry} />
            ))}
          </>
        )}
      </ScrollView>
      {canOperate && issue !== null ? (
        <View className="absolute inset-x-3 bottom-0" style={{ paddingBottom: bottomInset }}>
          <GlassSurface
            chrome="none"
            onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
            className="flex-row items-end gap-1 p-1"
          >
            <TextInput
              accessibilityLabel="Comment on issue"
              multiline
              maxLength={20_000}
              placeholder={
                issue.responsibleThreadId === null ? "Comment to start a conversation…" : "Comment…"
              }
              placeholderTextColorClassName="accent-foreground-muted"
              value={draft}
              onChangeText={setDraft}
              editable={!sending}
              className="max-h-36 min-h-12 min-w-0 flex-1 rounded-[24px] border-0 bg-transparent px-4 py-3 text-base text-foreground"
            />
            <View className="pb-0.5 pr-0.5">
              <MaterialIconButton
                accessibilityLabel="Send comment"
                icon="arrow.up"
                variant="primary"
                disabled={sending || draft.trim().length === 0}
                onPress={() => void send()}
              />
            </View>
          </GlassSurface>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function IssueSummary(props: {
  readonly issue: InboxIssue;
  readonly environmentLabel: string | null;
}) {
  const { issue } = props;
  const meta = [INBOX_SEVERITY_LABELS[issue.severity], props.environmentLabel, issue.source.label]
    .filter(Boolean)
    .join(" · ");
  return (
    <View className="gap-3">
      <Text className="text-xs font-t3-medium text-foreground-muted">{meta}</Text>
      {issue.state !== "open" ? (
        <Text className="text-sm font-t3-bold text-foreground-secondary">
          {issue.state === "resolved" ? "Resolved" : "Closed as not relevant"}
          {issue.closedAt ? ` · ${relativeTime(issue.closedAt)}` : ""}
        </Text>
      ) : issue.waitingForOwner ? (
        <Text className="text-sm font-t3-bold text-adaptive-rose-600-400">Needs your answer</Text>
      ) : null}
      {issue.repeatCount > 0 ? (
        <Text className="text-xs text-foreground-muted">Reported again ×{issue.repeatCount}</Text>
      ) : null}
      {issue.description.trim() ? (
        <View className="rounded-[18px] bg-grouped-card px-4 py-3">
          <PullRequestMarkdown markdown={issue.description} />
        </View>
      ) : null}
    </View>
  );
}

function IssueActions(props: {
  readonly issue: InboxIssue;
  readonly environmentId: EnvironmentId;
  readonly canOperate: boolean;
  readonly busy: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onClose: () => void;
  readonly onReopen: () => void;
}) {
  const { issue } = props;
  const responsible = issue.responsibleThreadId;
  const otherThreads = issue.threadIds.filter((threadId) => threadId !== responsible);
  return (
    <View className="gap-3 pt-4">
      {responsible !== null ? (
        <MaterialButton
          label="Open conversation"
          tone="contrast"
          onPress={() => props.onOpenThread(responsible)}
        />
      ) : (
        <Text className="text-sm text-foreground-muted">
          Your first comment starts a conversation with an agent.
        </Text>
      )}
      {otherThreads.length > 0 ? (
        <View className="gap-1">
          <Text className="text-xs text-foreground-muted">Other threads</Text>
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
      {props.canOperate && issue.state === "open" ? (
        <MaterialButton
          label="Close as not relevant"
          tone="secondary"
          disabled={props.busy}
          onPress={props.onClose}
        />
      ) : null}
      {props.canOperate && issue.state === "dismissed" ? (
        <MaterialButton
          label="Reopen"
          tone="secondary"
          disabled={props.busy}
          onPress={props.onReopen}
        />
      ) : null}
    </View>
  );
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
      className="py-1 text-sm font-t3-medium text-primary-text"
    >
      {thread?.title ?? "Untitled thread"}
    </Text>
  );
}

function IssueEntry(props: { readonly entry: InboxEntry }) {
  const presentation = presentInboxEntry(props.entry);
  const failures = failedInboxDeliveries(props.entry);
  const time = relativeTime(props.entry.createdAt);
  const warnings = failures.map((failure) => (
    <View key={failure} className="flex-row items-center gap-1.5 pt-1">
      <SymbolView
        name="exclamationmark.triangle"
        size={12}
        tintColorClassName="accent-warning-foreground"
        type="monochrome"
      />
      <Text selectable className="min-w-0 flex-1 text-xs text-warning-foreground">
        {failure}
      </Text>
    </View>
  ));

  if (presentation.kind === "comment") {
    const owner = presentation.side === "owner";
    return (
      <View className={cn("mb-3 max-w-[88%]", owner ? "self-end items-end" : "self-start")}>
        <View
          className={cn(
            "rounded-[18px] px-3.5 py-2.5",
            owner ? "bg-user-bubble" : "bg-grouped-card",
          )}
        >
          {owner ? (
            <Text selectable className="text-base text-user-bubble-foreground">
              {presentation.text}
            </Text>
          ) : (
            <PullRequestMarkdown markdown={presentation.text} />
          )}
        </View>
        <Text className="px-1 pt-1 text-2xs text-foreground-tertiary">
          {owner ? "You" : "Agent"} · {time}
        </Text>
        {warnings}
      </View>
    );
  }

  if (presentation.tone === "resolved") {
    return (
      <View className="mb-3 gap-1 rounded-[16px] bg-adaptive-emerald-500-a12-a16 px-3.5 py-3">
        <Text selectable className="text-sm font-t3-bold text-adaptive-emerald-700-300">
          {presentation.label}
        </Text>
        <Text className="text-2xs text-foreground-tertiary">{time}</Text>
        {warnings}
      </View>
    );
  }

  return (
    <View className="mb-2 px-1">
      <View className="flex-row items-start gap-2">
        <View className="mt-[6px] size-1.5 rounded-full bg-foreground-tertiary" />
        <Text
          selectable
          className={cn(
            "min-w-0 flex-1 text-sm",
            presentation.tone === "waiting"
              ? "font-t3-medium text-adaptive-rose-600-400"
              : presentation.tone === "closed"
                ? "font-t3-medium text-foreground-secondary"
                : "text-foreground-muted",
          )}
        >
          {presentation.label}
        </Text>
        <Text className="text-2xs tabular-nums text-foreground-tertiary">{time}</Text>
      </View>
      {presentation.detail ? (
        <Text selectable className="pl-3.5 pt-0.5 text-xs text-foreground-tertiary">
          {presentation.detail}
        </Text>
      ) : null}
      {warnings}
    </View>
  );
}
