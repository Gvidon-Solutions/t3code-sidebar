import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

function numeric(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Height for an editor whose style caps it with a numeric maxHeight: it follows
 * the native text height line by line, never below minHeight, and scrolls once
 * the text passes the cap. Editors without a numeric cap keep their own layout.
 */
export function composerEditorGrowHeight(
  style: StyleProp<ViewStyle>,
  contentHeight: number | null,
): number | undefined {
  if (contentHeight === null) return undefined;
  const flat = StyleSheet.flatten(style) ?? {};
  if (typeof flat.maxHeight !== "number") return undefined;
  const paddingTop = numeric(flat.paddingTop ?? flat.paddingVertical ?? flat.padding);
  const paddingBottom = numeric(flat.paddingBottom ?? flat.paddingVertical ?? flat.padding);
  const minHeight = numeric(flat.minHeight);
  return Math.min(
    flat.maxHeight,
    Math.max(minHeight, Math.ceil(contentHeight + paddingTop + paddingBottom)),
  );
}
