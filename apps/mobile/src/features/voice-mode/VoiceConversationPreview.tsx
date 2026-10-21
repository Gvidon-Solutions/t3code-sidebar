import { useEffect, useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useVoiceModeState } from "./useVoiceMode";
import { voiceMode } from "./voiceMode";
import {
  createSpeakingDetector,
  resolveVoiceStripStatus,
  VOICE_STRIP_STATUS_LABEL,
  voiceCaptionTail,
} from "./voiceModePresentation";

/**
 * Sidebar fork: the newest words of this device's voice conversation, for
 * views away from its thread (the compact strip, the bubble's panel). Your
 * words are italic, the answer plain; before anyone speaks it shows the state.
 */
export function VoiceConversationPreview(props: {
  /** How many of the latest captions to show. */
  readonly captions: number;
  /** Lines each caption wraps to before it is cut. */
  readonly linesPerCaption: number;
  /** Characters kept from the end of each caption. */
  readonly maxChars: number;
}) {
  const state = useVoiceModeState();
  const [speaking, setSpeaking] = useState(false);

  // Re-renders only when the speaking flag flips, not per level sample.
  useEffect(() => {
    const isSpeaking = createSpeakingDetector();
    return voiceMode.subscribeLevels((levels) => {
      setSpeaking(isSpeaking(levels.speaker, Date.now()));
    });
  }, []);

  const captions = state.captions.slice(-props.captions);
  if (captions.length === 0) {
    const status = resolveVoiceStripStatus({ phase: state.phase, muted: state.muted, speaking });
    return (
      <Text
        accessibilityLiveRegion="polite"
        className="text-sm text-foreground-muted"
        numberOfLines={1}
      >
        {VOICE_STRIP_STATUS_LABEL[status]}
      </Text>
    );
  }
  return captions.map((caption, index) => (
    <Text
      // Captions have no identity; the open one keeps its slot while it streams.
      // oxlint-disable-next-line react/no-array-index-key
      key={index}
      className={cn(
        "text-sm",
        caption.role === "user" ? "italic text-foreground-muted" : "text-foreground",
      )}
      numberOfLines={props.linesPerCaption}
    >
      {voiceCaptionTail(caption.text, props.maxChars)}
    </Text>
  ));
}
