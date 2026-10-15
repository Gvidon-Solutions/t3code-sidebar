import type { EnvironmentId, InboxIssueId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { InboxPage, type InboxSearch } from "../components/inbox/InboxPage";

/** Fork: the agent inbox. See FORK.md, "Agent inbox". */
export const Route = createFileRoute("/_chat/inbox")({
  validateSearch: (raw: Record<string, unknown>): InboxSearch => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.issueId === "string" && raw.issueId
      ? { issueId: raw.issueId as InboxIssueId }
      : {}),
    ...(raw.view === "open" || raw.view === "closed" ? { view: raw.view } : {}),
  }),
  component: InboxRouteView,
});

function InboxRouteView() {
  return <InboxPage search={Route.useSearch()} />;
}
