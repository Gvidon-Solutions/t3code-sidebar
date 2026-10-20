/**
 * Terminal tabs in the thread pager (sidebar fork). A terminal page is keyed
 * by a string that can never be a workspace path, so the pager, the tab strip
 * and the route's `tab` param carry files and terminals the same way.
 */

const TERMINAL_TAB_PREFIX = "\u0000terminal:";

export const terminalTabKey = (terminalId: string) => `${TERMINAL_TAB_PREFIX}${terminalId}`;

export function terminalIdFromTabKey(key: string | null | undefined): string | null {
  return key?.startsWith(TERMINAL_TAB_PREFIX) ? key.slice(TERMINAL_TAB_PREFIX.length) : null;
}

/**
 * The thread's terminal tabs: every live shell the server reports (opened here
 * or on the desktop), then shells this device asked for that the server has
 * not listed yet, in request order.
 */
export function mergeTerminalTabIds(
  live: ReadonlyArray<string>,
  requested: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const ids = [...live];
  for (const id of requested) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
