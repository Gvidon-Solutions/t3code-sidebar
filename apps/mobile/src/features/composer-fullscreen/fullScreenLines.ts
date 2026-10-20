/** The draft has to wrap to this many lines before ⤢ shows, as in ChatGPT. */
export const COMPOSER_FULL_SCREEN_MIN_LINES = 3;

/**
 * Whether a draft is tall enough to offer the full-screen editor. A little
 * slack below whole lines absorbs fractional font metrics.
 */
export function composerOffersFullScreen(contentHeight: number, lineHeight: number): boolean {
  if (lineHeight <= 0) return false;
  return contentHeight >= lineHeight * (COMPOSER_FULL_SCREEN_MIN_LINES - 0.5);
}

/**
 * Height the full-screen editor adds over the focused one's cap: the glimpse of the thread
 * kept above a focused composer (see `expandedEditorMaxHeight`), less the thread's tab strip.
 */
export const COMPOSER_FULL_SCREEN_EXTRA_HEIGHT = 48;
