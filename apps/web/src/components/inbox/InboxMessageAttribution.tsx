import { type EnvironmentId, type InboxIssueId, parseInboxDelivery } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { InlineButton } from "../ui/button";

/** Fork: an inbox delivery as the thread shows it, without the header and footer the agent reads. */
export function withInboxMessageText<M extends { readonly id?: string; readonly text: string }>(
  message: M,
): M {
  const inbox = parseInboxDelivery(message);
  return inbox === null ? message : { ...message, text: inbox.text };
}

/**
 * Fork: the label above a thread message the inbox delivered: the owner's
 * comment on an issue, or a notice about one. Opens the issue.
 */
export function InboxMessageAttribution(props: {
  readonly environmentId: EnvironmentId;
  readonly inbox: {
    readonly issueId: InboxIssueId;
    readonly title: string;
    readonly kind: "comment" | "notice";
  };
}) {
  const prefix = props.inbox.kind === "comment" ? "From inbox" : "Inbox notice";
  return (
    <p
      className="me-1 flex max-w-[80%] min-w-0 text-2xs text-muted-foreground/70"
      data-user-message-attribution="inbox"
    >
      <InlineButton
        tone="muted"
        className="max-w-full"
        render={
          <Link
            to="/inbox"
            search={{ environmentId: props.environmentId, issueId: props.inbox.issueId }}
          />
        }
      >
        <span className="truncate">
          {prefix} · {props.inbox.title}
        </span>
      </InlineButton>
    </p>
  );
}
