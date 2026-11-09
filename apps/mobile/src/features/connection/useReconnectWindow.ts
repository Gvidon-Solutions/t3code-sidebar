import { deadlineAfter } from "@t3tools/client-runtime/clock";
import { useState } from "react";

import { useDeadlinePassed } from "../../lib/clock";

export const OFFLINE_RECONNECT_WINDOW_MS = 2_000;

/** True once `active` has stayed continuously on for the reconnect window. */
export function useReconnectWindow(
  active: boolean,
  delayMs = OFFLINE_RECONNECT_WINDOW_MS,
): boolean {
  const [held, setHeld] = useState(() => ({ active, deadline: deadlineAfter(delayMs) }));
  if (held.active !== active) setHeld({ active, deadline: deadlineAfter(delayMs) });
  const elapsed = useDeadlinePassed(held.active ? held.deadline : null);
  return active && held.active === active && elapsed;
}
