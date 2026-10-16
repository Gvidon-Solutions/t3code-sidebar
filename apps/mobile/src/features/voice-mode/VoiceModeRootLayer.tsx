import { UiRequestCoordinator, type ShownThread } from "./UiRequestCoordinator";
import { useVoiceModeNotices } from "./useVoiceMode";
import { VoiceConversationBubble } from "./VoiceConversationBubble";

/**
 * Sidebar fork: what a voice conversation needs outside its thread, mounted
 * once over the whole navigator. `route` is the screen in front (sheets over
 * it ignored): the thread chat has its own strip, so the bubble stays away.
 */
export function VoiceModeRootLayer(props: {
  readonly route: { readonly name: string; readonly params?: object | undefined } | undefined;
}) {
  useVoiceModeNotices();
  const route = props.route;
  return (
    <>
      <UiRequestCoordinator shownThread={shownThreadOf(route)} />
      <VoiceConversationBubble hidden={route?.name === "Thread"} />
    </>
  );
}

/** The thread a thread screen (chat, file, review…) shows, from its route params. */
function shownThreadOf(route: Parameters<typeof VoiceModeRootLayer>[0]["route"]) {
  if (!route?.name.startsWith("Thread") || route.params === undefined) return null;
  const params = route.params as { readonly environmentId?: unknown; readonly threadId?: unknown };
  return typeof params.environmentId === "string" && typeof params.threadId === "string"
    ? ({ environmentId: params.environmentId, threadId: params.threadId } satisfies ShownThread)
    : null;
}
