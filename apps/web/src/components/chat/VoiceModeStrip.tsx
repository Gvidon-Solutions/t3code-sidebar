import type { VoiceSessionTarget } from "@t3tools/client-runtime/voice-mode";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AudioLinesIcon, MicIcon, MicOffIcon, SquareIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { VOICE_THREAD_TITLE } from "~/voice/voiceAvailability";
import {
  SPEAKING_LEVEL,
  isVoiceTargetFor,
  useVoiceModeState,
  useVoiceMuted,
  useVoicePhaseFor,
  useVoiceThreadRef,
  voiceMode,
} from "~/voice/voiceMode";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Spinner } from "../ui/spinner";
import { VoiceConversationPreview } from "../voice/VoiceConversationPreview";
import { ComposerBanner } from "./ComposerBanner";

const VISIBLE_CAPTIONS = 2;
// Per-bar gain so a meter reads as a small waveform rather than one block.
const METER_BARS = [
  { id: "low", gain: 0.6 },
  { id: "mid", gain: 1 },
  { id: "high", gain: 0.75 },
] as const;
const METER_IDLE_SCALE = 0.2;

function meterScale(level: number, gain: number): number {
  // audioLevel is linear amplitude; speech sits well below 0.5, so a square
  // root spreads it over the bar's height.
  return Math.max(METER_IDLE_SCALE, Math.min(1, Math.sqrt(level) * 1.6 * gain));
}

function applyMeterLevel(meter: HTMLElement | null, level: number) {
  if (!meter) return;
  const bars = meter.children;
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index] as HTMLElement;
    bar.style.transform = `scaleY(${meterScale(level, METER_BARS[index]?.gain ?? 1)})`;
  }
}

function LevelMeter({
  meterRef,
  label,
  staticLevel,
}: {
  meterRef: React.RefObject<HTMLSpanElement | null>;
  label: string;
  /** Fixed bar height when levels are not animated (reduced motion). */
  staticLevel: number;
}) {
  return (
    <span
      ref={meterRef}
      role="img"
      aria-label={label}
      className="flex h-3 flex-none items-center gap-px"
    >
      {METER_BARS.map((bar) => (
        <span
          key={bar.id}
          className="h-full w-0.5 origin-center rounded-full bg-current"
          style={{ transform: `scaleY(${meterScale(staticLevel, bar.gain)})` }}
        />
      ))}
    </span>
  );
}

/**
 * The voice strip above a thread's composer: the full strip on the thread that
 * holds this client's conversation, a compact one on every other thread.
 */
export const VoiceModeStrip = memo(function VoiceModeStrip({
  target,
  onTalkHere,
}: {
  target: VoiceSessionTarget;
  /** Moves the conversation to this thread; null when this thread has no voice. */
  onTalkHere: (() => void) | null;
}) {
  const onThread = useVoicePhaseFor(target) !== "idle";
  return onThread ? (
    <ThreadVoiceStrip target={target} />
  ) : (
    <ElsewhereVoiceStrip onTalkHere={onTalkHere} />
  );
});

/**
 * A conversation held on another thread: its newest words, mute, stop, and a
 * way to bring it here. Clicking the words opens its thread.
 */
function ElsewhereVoiceStrip({ onTalkHere }: { onTalkHere: (() => void) | null }) {
  const voiceThreadRef = useVoiceThreadRef();
  if (voiceThreadRef === null) return null;
  return <ElsewhereVoiceStripRow voiceThreadRef={voiceThreadRef} onTalkHere={onTalkHere} />;
}

function ElsewhereVoiceStripRow({
  voiceThreadRef,
  onTalkHere,
}: {
  voiceThreadRef: ScopedThreadRef;
  onTalkHere: (() => void) | null;
}) {
  const muted = useVoiceMuted();
  const title = useThreadShell(voiceThreadRef)?.title ?? VOICE_THREAD_TITLE;
  const navigate = useNavigate();
  return (
    <ComposerBanner.Root data-chat-composer-voice-strip="elsewhere">
      <ComposerBanner.Row>
        <ComposerBanner.Icon>
          <AudioLinesIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Open the voice conversation: ${title}`}
                  className="min-w-0 flex-1 text-left"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(voiceThreadRef),
                    })
                  }
                />
              }
            >
              <VoiceConversationPreview captions={1} linesPerCaption={4} maxChars={480} />
            </TooltipTrigger>
            <TooltipPopup side="top">Open the voice conversation</TooltipPopup>
          </Tooltip>
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            onClick={() => voiceMode.toggleMuted()}
          >
            {muted ? <MicOffIcon aria-hidden /> : <MicIcon aria-hidden />}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => voiceMode.stop()}>
            <SquareIcon className="size-3" aria-hidden />
            Stop
          </Button>
          {onTalkHere ? (
            <Button size="xs" variant="ghost" onClick={onTalkHere}>
              Talk here
            </Button>
          ) : null}
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
}

/**
 * Live status for the thread's voice conversation: state, mic and speaker
 * meters, mute and stop, and the latest captions. Meters are written straight
 * to the DOM from the controller's level samples so the composer never
 * re-renders per sample.
 */
function ThreadVoiceStrip({ target }: { target: VoiceSessionTarget }) {
  const state = useVoiceModeState();
  const isOnThread = isVoiceTargetFor(state, target) && state.phase !== "idle";
  const isActive = isOnThread && state.phase === "active";
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const microphoneMeterRef = useRef<HTMLSpanElement>(null);
  const speakerMeterRef = useRef<HTMLSpanElement>(null);
  const [speaking, setSpeaking] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to voice audio levels and paints the meters' DOM nodes
  useEffect(() => {
    if (!isActive) return;
    // Teardown publishes a silent sample, which clears `speaking` for the next conversation.
    return voiceMode.subscribeLevels((levels) => {
      setSpeaking(levels.speaker > SPEAKING_LEVEL);
      if (prefersReducedMotion) return;
      applyMeterLevel(microphoneMeterRef.current, levels.microphone);
      applyMeterLevel(speakerMeterRef.current, levels.speaker);
    });
  }, [isActive, prefersReducedMotion]);

  if (!isOnThread) return null;

  const status = !isActive
    ? "Connecting…"
    : speaking
      ? "Speaking"
      : state.muted
        ? "Muted"
        : "Listening";
  const captions = state.captions.slice(-VISIBLE_CAPTIONS);
  // Reduced motion keeps the meters still: full while a channel is live, low while muted.
  const staticMicrophoneLevel = prefersReducedMotion && isActive && !state.muted ? 0.4 : 0;
  const staticSpeakerLevel = prefersReducedMotion && speaking ? 0.4 : 0;

  return (
    <ComposerBanner.Root data-chat-composer-voice-strip="true">
      <ComposerBanner.Row>
        <ComposerBanner.Icon>{isActive ? <AudioLinesIcon /> : <Spinner />}</ComposerBanner.Icon>
        <ComposerBanner.Content className="gap-2">
          <span className="shrink-0 whitespace-nowrap text-muted-foreground" role="status">
            {status}
          </span>
          {isActive ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="flex items-center gap-1">
                {state.muted ? (
                  <MicOffIcon className="size-3" aria-hidden />
                ) : (
                  <MicIcon className="size-3" aria-hidden />
                )}
                <LevelMeter
                  meterRef={microphoneMeterRef}
                  label="Microphone level"
                  staticLevel={staticMicrophoneLevel}
                />
              </span>
              <span className="flex items-center gap-1">
                <AudioLinesIcon className="size-3" aria-hidden />
                <LevelMeter
                  meterRef={speakerMeterRef}
                  label="Speaker level"
                  staticLevel={staticSpeakerLevel}
                />
              </span>
            </span>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <Button size="xs" variant="ghost" onClick={() => voiceMode.toggleMuted()}>
            {state.muted ? "Unmute" : "Mute"}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => voiceMode.stop()}>
            <SquareIcon className="size-3" aria-hidden />
            Stop
          </Button>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      {captions.length > 0 ? (
        <ComposerBanner.Body className="flex flex-col gap-0.5 pe-2 pb-1">
          {captions.map((caption, index) => (
            <p
              // Captions have no identity; the open one keeps its slot while it streams.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className={cn(
                "line-clamp-2 min-w-0 break-words",
                caption.role === "user" ? "text-muted-foreground italic" : "text-foreground",
              )}
            >
              {caption.text}
            </p>
          ))}
        </ComposerBanner.Body>
      ) : null}
    </ComposerBanner.Root>
  );
}
