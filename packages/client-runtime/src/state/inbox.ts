import { INBOX_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Fork: agent inbox atoms for one client runtime. */
export function createInboxAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    /** Open issues and the newest closed ones, live. */
    inboxLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:inbox:live",
      tag: INBOX_WS_METHODS.subscribe,
    }),
    /** One issue and its history, live. */
    inboxIssueLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:inbox:issue",
      tag: INBOX_WS_METHODS.subscribeIssue,
    }),
    commentOnIssue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:inbox:comment",
      tag: INBOX_WS_METHODS.comment,
    }),
    markIssueSeen: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:inbox:mark-seen",
      tag: INBOX_WS_METHODS.markSeen,
    }),
    dismissIssue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:inbox:dismiss",
      tag: INBOX_WS_METHODS.dismiss,
    }),
    undismissIssue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:inbox:undismiss",
      tag: INBOX_WS_METHODS.undismiss,
    }),
  };
}
