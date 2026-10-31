/**
 * A draft composer's settings belong to the flow's draft (`draftKey`), while a
 * real thread keeps them on the thread even when a queued edit is open.
 */
export function resolveComposerSettingsKey(input: {
  readonly isDraft: boolean | undefined;
  readonly draftKey: string | undefined;
  readonly threadKey: string;
}): string {
  return input.isDraft ? (input.draftKey ?? input.threadKey) : input.threadKey;
}
