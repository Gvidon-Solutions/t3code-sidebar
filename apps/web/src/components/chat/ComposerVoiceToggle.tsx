import { AudioLinesIcon } from "lucide-react";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The composer's voice conversation toggle; absent when the provider has no voice. */
export function ComposerVoiceToggle(props: {
  readonly supported: boolean;
  readonly engaged: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) {
  if (!props.supported) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            variant="ghost"
            size="sm"
            pressed={props.engaged}
            onPointerDown={(event) => event.preventDefault()}
            onPressedChange={props.onToggle}
            aria-label={props.label}
          />
        }
      >
        <AudioLinesIcon />
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}
