import { WifiOffIcon } from "lucide-react";
import { offlineConversationEmptyText } from "@t3tools/client-runtime/state/mesh-machines";

import { Button } from "../ui/button";

/** A thread whose machine is offline and whose conversation was never saved on this device. */
export function OfflineConversationEmptyState(props: {
  readonly machineLabel: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 pb-24 text-center">
      <WifiOffIcon className="size-7 text-muted-foreground" aria-hidden="true" />
      <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
        {offlineConversationEmptyText(props.machineLabel)}
      </p>
      <Button size="sm" variant="outline" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}
