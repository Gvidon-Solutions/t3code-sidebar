import { type EnvironmentId, type InboxIssueId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { InlineButton } from "../ui/button";

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
