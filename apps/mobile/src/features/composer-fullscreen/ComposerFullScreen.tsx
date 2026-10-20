import { useCallback, useEffect, useState } from "react";
import { BackHandler, Pressable } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { composerOffersFullScreen } from "./fullScreenLines";

/**
 * Full-screen draft editing (sidebar fork). The composer reports its text
 * height; once the draft wraps to a few lines it offers ⤢, which grows the
 * same editor over the screen. ⤡, Back and sending return to the normal card.
 * ⤢ stays while full screen even if the text shrinks, so the way out is there.
 */
export function useComposerFullScreen(lineHeight: number) {
  const [contentHeight, setContentHeight] = useState(0);
  const [fullScreen, setFullScreen] = useState(false);
  const close = useCallback(() => setFullScreen(false), []);
  const open = useCallback(() => setFullScreen(true), []);
  const toggle = useCallback(() => setFullScreen((current) => !current), []);

  useEffect(() => {
    if (!fullScreen) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setFullScreen(false);
      return true;
    });
    return () => subscription.remove();
  }, [fullScreen]);

  return {
    fullScreen,
    offersFullScreen: fullScreen || composerOffersFullScreen(contentHeight, lineHeight),
    onContentHeightChange: setContentHeight,
    open,
    close,
    toggle,
  };
}

export function ComposerFullScreenButton(props: {
  readonly fullScreen: boolean;
  readonly onPress: () => void;
}) {
  const { scale } = useAndroidControlSizing();
  return (
    <Pressable
      accessibilityLabel={props.fullScreen ? "Collapse editor" : "Expand editor"}
      accessibilityRole="button"
      testID="composer-full-screen-toggle"
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70"
      hitSlop={4}
      onPress={props.onPress}
    >
      <SymbolView
        name={
          props.fullScreen
            ? "arrow.down.right.and.arrow.up.left"
            : "arrow.up.left.and.arrow.down.right"
        }
        size={Math.round(18 * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );
}

export { COMPOSER_FULL_SCREEN_EXTRA_HEIGHT } from "./fullScreenLines";
