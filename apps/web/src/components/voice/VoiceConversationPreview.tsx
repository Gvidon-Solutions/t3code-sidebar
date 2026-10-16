import { voiceCaptionTail } from "@t3tools/client-runtime/voice-mode";

import { cn } from "~/lib/utils";
import { useVoiceCaptions, useVoiceModeState, useVoiceSpeaking } from "~/voice/voiceMode";

const LINE_CLAMP = {
  1: "truncate",
  2: "line-clamp-2 break-words",
  3: "line-clamp-3 break-words",
  4: "line-clamp-4 break-words",
} as const;

/** What the conversation is doing when nobody's words are on screen. */
export function useVoiceStatus(): string {
  const state = useVoiceModeState();
  const speaking = useVoiceSpeaking(state.phase === "active");
  if (state.phase === "connecting") return "Connecting…";
  if (speaking) return "Speaking";
  return state.muted ? "Muted" : "Listening";
}

/**
 * Fork: the newest words of this client's voice conversation, for views away
 * from its thread (the compact strip, the floating bubble). Your words are
 * italic, the answer plain; before anyone speaks it shows the state.
 */
export function VoiceConversationPreview({
  captions: count,
  linesPerCaption,
  maxChars,
  className,
}: {
  /** How many of the latest captions to show. */
  captions: number;
  /** Lines each caption wraps to before it is cut. */
  linesPerCaption: keyof typeof LINE_CLAMP;
  /** Characters kept from the end of each caption. */
  maxChars: number;
  className?: string;
}) {
  const captions = useVoiceCaptions().slice(-count);
  const status = useVoiceStatus();
  if (captions.length === 0) {
    return (
      <span className={cn("text-muted-foreground", className)} role="status">
        {status}
      </span>
    );
  }
  return (
    <span className={cn("flex min-w-0 flex-col", className)}>
      {captions.map((caption, index) => (
        <span
          // Captions have no identity; the open one keeps its slot while it streams.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className={cn(
            "min-w-0",
            LINE_CLAMP[linesPerCaption],
            caption.role === "user" ? "text-muted-foreground italic" : "text-foreground",
          )}
        >
          {voiceCaptionTail(caption.text, maxChars)}
        </span>
      ))}
    </span>
  );
}
