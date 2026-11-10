import type { ReactNode } from "react";

export interface SheetProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  /** Blocks the close button and the swipe, such as while a submit is in flight. */
  readonly dismissDisabled?: boolean;
  /** Paint the native header with the sheet color instead of letting the dimmed screen show through. */
  readonly opaqueHeader?: boolean;
}
