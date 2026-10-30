import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AudioLinesIcon, MicIcon, MicOffIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "~/threadRoutes";
import { VOICE_THREAD_TITLE } from "~/voice/voiceAvailability";
import { useVoiceMuted, useVoicePhaseFor, useVoiceThreadRef, voiceMode } from "~/voice/voiceMode";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Spinner } from "../ui/spinner";
import { VoiceConversationPreview } from "./VoiceConversationPreview";

const POSITION_STORAGE_KEY = "t3code:voice-bubble:v1";
/** The bubble's footprint (Button size icon-lg) plus the gap kept to the window edge. */
const BUBBLE_SIZE = 40;
const EDGE_GAP = 8;
/** Movement below this is a tap, not a drag. */
const DRAG_THRESHOLD = 4;

interface BubblePosition {
  readonly x: number;
  readonly y: number;
}

function clampToViewport(position: BubblePosition): BubblePosition {
  const maxX = Math.max(EDGE_GAP, window.innerWidth - BUBBLE_SIZE - EDGE_GAP);
  const maxY = Math.max(EDGE_GAP, window.innerHeight - BUBBLE_SIZE - EDGE_GAP);
  return {
    x: Math.min(Math.max(position.x, EDGE_GAP), maxX),
    y: Math.min(Math.max(position.y, EDGE_GAP), maxY),
  };
}

function readStoredPosition(): BubblePosition {
  try {
    const stored = JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY) ?? "null") as unknown;
    if (
      stored !== null &&
      typeof stored === "object" &&
      "x" in stored &&
      "y" in stored &&
      typeof stored.x === "number" &&
      typeof stored.y === "number"
    ) {
      return clampToViewport({ x: stored.x, y: stored.y });
    }
  } catch {
    // A broken entry falls back to the default corner.
  }
  return clampToViewport({ x: window.innerWidth, y: window.innerHeight - 96 });
}

function writeStoredPosition(position: BubblePosition) {
  try {
    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
  } catch {
    // Storage can be full or off; the bubble still works for this session.
  }
}

/**
 * Fork: while this client holds a voice conversation and no thread is open
 * (inbox, settings, home), a small bubble keeps it in reach. Drag it anywhere;
 * a tap opens its newest words (click them for the thread), mute and stop. Thread routes have the voice
 * strip above the composer instead. Mounted once at the app root.
 */
export function VoiceBubble() {
  const voiceThreadRef = useVoiceThreadRef();
  const onThreadRoute = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params) !== null,
  });
  if (voiceThreadRef === null || onThreadRoute) return null;
  return <FloatingVoiceBubble voiceThreadRef={voiceThreadRef} />;
}

function FloatingVoiceBubble({ voiceThreadRef }: { voiceThreadRef: ScopedThreadRef }) {
  const phase = useVoicePhaseFor(voiceThreadRef);
  const muted = useVoiceMuted();
  const title = useThreadShell(voiceThreadRef)?.title ?? VOICE_THREAD_TITLE;
  const navigate = useNavigate();
  const [position, setPosition] = useState(readStoredPosition);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: BubblePosition;
    /** Set once the pointer moved past DRAG_THRESHOLD. */
    last: BubblePosition | null;
  } | null>(null);
  // The click that ends a drag must not toggle the panel.
  const suppressClickRef = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens to window resizes to keep the bubble on screen
  useEffect(() => {
    const onResize = () => setPosition((current) => clampToViewport(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the bubble on outside pointer down or Escape through document listeners
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const onPointerDown = (event: ReactPointerEvent) => {
    const bubble = bubbleRef.current;
    if (event.button !== 0 || !bubble?.contains(event.target as Node)) return;
    bubble.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: position,
      last: null,
    };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.last === null && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.last = clampToViewport({ x: drag.origin.x + dx, y: drag.origin.y + dy });
    setPosition(drag.last);
  };
  const onPointerEnd = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.last === null) return;
    suppressClickRef.current = true;
    writeStoredPosition(drag.last);
  };

  // The panel opens toward the larger part of the window.
  const opensUp = position.y > window.innerHeight / 2;
  const alignsRight = position.x > window.innerWidth / 2;

  return (
    <div
      ref={rootRef}
      className="fixed z-40 touch-none select-none"
      style={{ left: position.x, top: position.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <Button
        ref={bubbleRef}
        variant="glass"
        size="icon-lg"
        aria-label={`Voice conversation: ${title}`}
        aria-expanded={open}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          setOpen((current) => !current);
        }}
      >
        {phase === "connecting" ? <Spinner /> : muted ? <MicOffIcon /> : <AudioLinesIcon />}
      </Button>
      {open ? (
        <div
          className={cn(
            "absolute flex w-64 flex-col gap-1",
            opensUp ? "bottom-full mb-2" : "top-full mt-2",
            alignsRight ? "right-0" : "left-0",
            "rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg",
          )}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Open the voice conversation: ${title}`}
                  className="flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    setOpen(false);
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(voiceThreadRef),
                    });
                  }}
                />
              }
            >
              <VoiceConversationPreview captions={2} linesPerCaption={2} maxChars={160} />
            </TooltipTrigger>
            <TooltipPopup side="top">Open the voice conversation</TooltipPopup>
          </Tooltip>
          <div className="flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => voiceMode.toggleMuted()}>
              {muted ? <MicIcon aria-hidden /> : <MicOffIcon aria-hidden />}
              {muted ? "Unmute" : "Mute"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                voiceMode.stop();
              }}
            >
              <SquareIcon aria-hidden />
              Stop
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
