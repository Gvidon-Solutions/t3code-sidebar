import { useEffect } from "react";

import { refreshTheme, useTheme } from "~/hooks/useTheme";

/**
 * Applies the saved/system appearance on every route, including the pages that
 * render before an environment is available (`/pair`, `/connect`, guest).
 * Without a subscriber those pages kept the appearance the boot script chose
 * at load, even after the system preference changed.
 */
export function ThemeRouteSync() {
  const { resolvedTheme } = useTheme();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies the theme after a route mounts outside the app shell
  useEffect(() => {
    if (resolvedTheme) refreshTheme({ preservePreview: true });
  }, [resolvedTheme]);
  return null;
}
