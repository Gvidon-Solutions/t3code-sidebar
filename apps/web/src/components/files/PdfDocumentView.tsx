import {
  ExternalLinkIcon,
  MoveHorizontalIcon,
  RotateCwIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";

import { PDF_SCOPE_CLASS, type PdfStack, createPdfStack } from "./pdfStack";

/**
 * PDFs render with pdf.js rather than the browser's viewer: the native viewer
 * cannot report or restore its position, so every rebuild of a LaTeX paper sent
 * the reader back to page one. A new revision now renders behind the shown one
 * and replaces it at the same zoom and scroll offset.
 */
export function PdfDocumentView(props: {
  readonly src: string;
  readonly title: string;
  /** A change loads the latest `src`; a URL renewal alone does not reload. */
  readonly reloadKey: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<PdfStack | null>(null);
  const srcRef = useRef(props.src);
  // Declared before the effects that read it, so they see this render's URL.
  useEffect(() => {
    srcRef.current = props.src;
  }, [props.src]);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let disposed = false;
    let stack: PdfStack | null = null;
    void createPdfStack(host, setStatus).then(
      (created) => {
        if (disposed) {
          created.destroy();
          return;
        }
        stack = created;
        stackRef.current = created;
        void created.show(srcRef.current);
      },
      () => setStatus("failed"),
    );
    return () => {
      disposed = true;
      stack?.destroy();
      stackRef.current = null;
    };
  }, []);

  const shownReloadKey = useRef(props.reloadKey);
  useEffect(() => {
    if (props.reloadKey === shownReloadKey.current) return;
    shownReloadKey.current = props.reloadKey;
    void stackRef.current?.show(srcRef.current);
  }, [props.reloadKey]);

  const reload = () => {
    const url = new URL(srcRef.current, window.location.href);
    url.searchParams.set("t3-reload", String(Date.now()));
    void stackRef.current?.show(url.href);
  };
  const openExternally = () => {
    const api = readLocalApi();
    if (api) {
      void api.shell.openExternal(srcRef.current).catch((cause: unknown) => console.error(cause));
      return;
    }
    window.open(srcRef.current, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col" role="document" aria-label={props.title}>
      <div className="flex shrink-0 items-center gap-0.5 border-b px-2 py-1">
        <ToolbarButton label="Zoom out" onClick={() => stackRef.current?.zoom(-1)}>
          <ZoomOutIcon />
        </ToolbarButton>
        <ToolbarButton label="Zoom in" onClick={() => stackRef.current?.zoom(1)}>
          <ZoomInIcon />
        </ToolbarButton>
        <ToolbarButton label="Fit width" onClick={() => stackRef.current?.fitWidth()}>
          <MoveHorizontalIcon />
        </ToolbarButton>
        <div className="flex-1" />
        <ToolbarButton label="Reload" onClick={reload}>
          <RotateCwIcon />
        </ToolbarButton>
        <ToolbarButton label="Open in browser" onClick={openExternally}>
          <ExternalLinkIcon />
        </ToolbarButton>
      </div>
      <div className="relative min-h-0 flex-1 bg-muted">
        <div ref={hostRef} className={cn("absolute inset-0", PDF_SCOPE_CLASS)} />
        {status === "loading" ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <Spinner size="lg" />
          </div>
        ) : status === "failed" ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-destructive">
            Unable to load PDF.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolbarButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}
