import type { ReactNode } from "react";

export interface SheetProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  /** Paint the native header with the sheet color instead of letting the dimmed screen show through. */
  readonly opaqueHeader?: boolean;
}
