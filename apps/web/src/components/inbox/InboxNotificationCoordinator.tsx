import {
  inboxAlertTitle,
  inboxIssueKey,
  type ScopedInboxIssue,
} from "@t3tools/client-runtime/inbox";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import { inboxStateAtom } from "../../state/inbox";
import { useAtomValue } from "@effect/atom-react";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../../threadNotifications";
import { toastManager } from "../ui/toast";
import { type InboxAlertMarksByEnvironment, collectInboxAlertsByEnvironment } from "./inbox.logic";

/**
 * Fork: announces new inbox news (a new issue, an agent's comment, a problem
 * coming back) with the same notification mode and sounds as threads. Mounted
 * once next to ThreadNotificationCoordinator. Daily reminders do not raise
 * `alertSequence`, so they are never announced. `info` issues stay silent.
 */
export function InboxNotificationCoordinator() {
  const state = useAtomValue(inboxStateAtom);
  const navigate = useNavigate();
  const viewing = useLocation({
    select: (location) => {
      if (location.pathname !== "/inbox") return null;
      const search = location.search as { environmentId?: unknown; issueId?: unknown };
      return typeof search.environmentId === "string" && typeof search.issueId === "string"
        ? `${search.environmentId}:${search.issueId}`
        : null;
    },
  });
  const marks = useRef<InboxAlertMarksByEnvironment>(new Map());
  const notifications = useRef(new Map<string, Notification>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes desktop notifications when the window gains focus
  useEffect(() => {
    const clear = () => {
      for (const notification of notifications.current.values()) notification.close();
      notifications.current.clear();
    };
    window.addEventListener("focus", clear);
    return () => {
      window.removeEventListener("focus", clear);
      clear();
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- raises sounds and desktop notifications for new inbox activity
  useEffect(() => {
    const result = collectInboxAlertsByEnvironment(marks.current, state.environments);
    marks.current = result.marks;
    if (result.alerts.length === 0) return;
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const focused = document.visibilityState === "visible" && document.hasFocus();
    const alerts = result.alerts.filter((item) => !(focused && viewing === inboxIssueKey(item)));
    if (alerts.length === 0) return;
    if (hasNotificationSound(mode) && alerts.some((item) => item.issue.severity !== "info")) {
      void playNotificationSound("input", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    const open = (item: ScopedInboxIssue) =>
      void navigate({
        to: "/inbox",
        search: { environmentId: item.environmentId, issueId: item.issue.id },
      });
    for (const item of alerts) {
      const title = inboxAlertTitle(item.issue);
      const body = `${item.environmentLabel} · ${item.issue.source.label}`;
      if (focused) {
        if (!inAppNotificationsEnabled) continue;
        const toastId = toastManager.add({
          type: item.issue.severity === "action" ? "warning" : "info",
          title,
          description: body,
          data: {
            hideCopyButton: true,
            leadingIcon: <InboxIcon aria-hidden className="size-4 text-info-foreground" />,
          },
          actionProps: {
            children: "Open",
            onClick: () => {
              toastManager.close(toastId);
              open(item);
            },
          },
        });
        continue;
      }
      if (
        !hasDesktopNotifications(mode) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      ) {
        continue;
      }
      try {
        const tag = `inbox:${inboxIssueKey(item)}`;
        notifications.current.get(tag)?.close();
        const notification = new Notification(title, { body, tag, silent: true });
        notifications.current.set(tag, notification);
        notification.addEventListener("click", () => {
          notification.close();
          notifications.current.delete(tag);
          window.focus();
          open(item);
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
  }, [navigate, state.environments, viewing]);

  return null;
}
