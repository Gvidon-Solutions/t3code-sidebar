import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import type { EventBus, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";

export const PDF_SCOPE_CLASS = "t3-pdf-document";

type PdfStatus = "loading" | "ready" | "failed";

interface Layer {
  readonly container: HTMLDivElement;
  readonly viewer: PDFViewer;
  readonly eventBus: EventBus;
  readonly document: PDFDocumentProxy;
  readonly task: PDFDocumentLoadingTask;
}

export interface PdfStack {
  /** Shows `url` in place of the current document, keeping its zoom and scroll offset. */
  readonly show: (url: string) => Promise<void>;
  readonly zoom: (steps: number) => void;
  readonly fitWidth: () => void;
  readonly destroy: () => void;
}

/** A rebuild may still be writing the file; past this the new revision shows even half-drawn. */
const REVEAL_TIMEOUT_MS = 2_000;

// The viewer reads the library from `globalThis.pdfjsLib`, which `pdfjs-dist` sets on load,
// so the two load in order and only once a PDF is opened.
let pdfjsModules: Promise<{
  lib: typeof import("pdfjs-dist");
  viewer: typeof import("pdfjs-dist/web/pdf_viewer.mjs");
}> | null = null;
function loadPdfjs() {
  pdfjsModules ??= (async () => {
    const lib = await import("pdfjs-dist");
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    const [viewer, css] = await Promise.all([
      import("pdfjs-dist/web/pdf_viewer.mjs"),
      import("pdfjs-dist/web/pdf_viewer.css?inline"),
    ]);
    // The viewer's sheet sets `color-scheme` and variables on `:root`; keep all of it inside
    // the PDF view so the app around it is untouched.
    const style = document.createElement("style");
    style.textContent = `@scope (.${PDF_SCOPE_CLASS}) {${css.default.replaceAll(":root", ":scope")}}`;
    document.head.append(style);
    return { lib, viewer };
  })();
  pdfjsModules.catch(() => {
    pdfjsModules = null;
  });
  return pdfjsModules;
}

export async function createPdfStack(
  host: HTMLElement,
  onStatus: (status: PdfStatus) => void,
): Promise<PdfStack> {
  const { lib, viewer: viewerModule } = await loadPdfjs();
  let current: Layer | null = null;
  let generation = 0;
  let destroyed = false;

  const disposeLayer = (layer: Layer) => {
    layer.viewer.setDocument(null);
    layer.container.remove();
    void layer.task.destroy();
  };

  const createLayer = (
    task: PDFDocumentLoadingTask,
    document: PDFDocumentProxy,
    hidden: boolean,
  ): Layer => {
    const container = window.document.createElement("div");
    // PDFViewer requires an absolutely positioned scroll container around a `.pdfViewer`.
    container.style.cssText = `position:absolute;inset:0;overflow:auto;${hidden ? "visibility:hidden;" : ""}`;
    const viewerElement = window.document.createElement("div");
    viewerElement.className = "pdfViewer";
    container.append(viewerElement);
    host.append(container);
    const eventBus = new viewerModule.EventBus();
    const linkService = new viewerModule.PDFLinkService({
      eventBus,
      externalLinkTarget: viewerModule.LinkTarget.BLANK,
    });
    const viewer = new viewerModule.PDFViewer({
      container,
      viewer: viewerElement,
      eventBus,
      linkService,
    });
    linkService.setViewer(viewer);
    linkService.setDocument(document);
    viewer.setDocument(document);
    container.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        if (event.deltaY < 0) viewer.increaseScale();
        else viewer.decreaseScale();
      },
      { passive: false },
    );
    return { container, viewer, eventBus, document, task };
  };

  const waitFor = (eventBus: EventBus, name: string, matches: (event: never) => boolean) =>
    new Promise<void>((resolve) => {
      const timeout = window.setTimeout(done, REVEAL_TIMEOUT_MS);
      function listener(event: never) {
        if (matches(event)) done();
      }
      function done() {
        window.clearTimeout(timeout);
        eventBus.off(name, listener);
        resolve();
      }
      eventBus.on(name, listener);
    });

  const show = async (url: string) => {
    const token = ++generation;
    const task = lib.getDocument({ url });
    let document: PDFDocumentProxy;
    try {
      document = await task.promise;
    } catch (cause) {
      if (destroyed || token !== generation) return;
      // A rebuild that is still writing the file fails to parse; keep the last good revision.
      if (current === null) onStatus("failed");
      else console.warn("PDF revision did not load", cause);
      return;
    }
    if (destroyed || token !== generation) {
      void task.destroy();
      return;
    }
    const previous = current;
    if (
      previous !== null &&
      previous.document.fingerprints.join() === document.fingerprints.join()
    ) {
      void task.destroy();
      return;
    }
    const layer = createLayer(task, document, previous !== null);
    await waitFor(layer.eventBus, "pagesinit", () => true);
    if (destroyed || token !== generation) {
      disposeLayer(layer);
      return;
    }
    if (previous === null) {
      layer.viewer.currentScaleValue = "page-width";
    } else {
      layer.viewer.currentScaleValue = previous.viewer.currentScaleValue;
      layer.container.scrollTop = previous.container.scrollTop;
      layer.container.scrollLeft = previous.container.scrollLeft;
      const page = layer.viewer.currentPageNumber;
      await waitFor(
        layer.eventBus,
        "pagerendered",
        (event: { pageNumber: number }) => event.pageNumber === page,
      );
      if (destroyed || token !== generation) {
        disposeLayer(layer);
        return;
      }
      // The reader may have scrolled while the new revision rendered.
      layer.container.scrollTop = previous.container.scrollTop;
      layer.container.scrollLeft = previous.container.scrollLeft;
      layer.container.style.visibility = "";
      disposeLayer(previous);
    }
    current = layer;
    onStatus("ready");
  };

  return {
    show,
    zoom: (steps) => {
      if (steps > 0) current?.viewer.increaseScale({ steps });
      else if (steps < 0) current?.viewer.decreaseScale({ steps: -steps });
    },
    fitWidth: () => {
      if (current) current.viewer.currentScaleValue = "page-width";
    },
    destroy: () => {
      destroyed = true;
      if (current) disposeLayer(current);
      current = null;
    },
  };
}
