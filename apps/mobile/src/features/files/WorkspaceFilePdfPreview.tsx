import { useMemo, useState } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { useReportPageEdges } from "../panels/threadPagerContext";
import { FilePreviewLoading } from "./FilePreviewFeedback";

// Pinned pdf.js build. Android's WebView cannot display PDFs itself, so the
// sidebar fork renders them with pdf.js; the file loads from the server's own
// origin (the page's base URL) and never crosses origins.
const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";

function pdfViewerHtml(pdfUrl: string, restoreScrollY: number): string {
  return `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<style>
  html, body { margin: 0; background: #525659; }
  #pages { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 8px 0; }
  canvas { background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
  #status { color: #eee; font: 14px sans-serif; padding: 32px 16px; text-align: center; }
</style></head>
<body><div id="status">Loading PDF…</div><div id="pages"></div>
<script type="module">
const CDN = ${JSON.stringify(PDFJS_CDN)};
const URL_ = ${JSON.stringify(pdfUrl)};
let restoreY = ${JSON.stringify(Math.max(0, Math.round(restoreScrollY)))};
const post = (message) => window.ReactNativeWebView.postMessage(JSON.stringify(message));
const status = document.getElementById("status");
let timer = null;
window.addEventListener("scroll", () => {
  clearTimeout(timer);
  timer = setTimeout(() => post({ type: "scroll", y: window.scrollY }), 400);
}, { passive: true });
// A zoomed page pans sideways itself; the thread pager flips only at its edges.
let edges = "";
const reportEdges = () => {
  const view = window.visualViewport;
  if (!view) return;
  const left = view.pageLeft <= 1;
  const right = view.pageLeft + view.width >= document.documentElement.scrollWidth - 1;
  const next = left + ":" + right;
  if (next === edges) return;
  edges = next;
  post({ type: "edges", prev: left, next: right });
};
window.visualViewport?.addEventListener("scroll", reportEdges);
window.visualViewport?.addEventListener("resize", reportEdges);
try {
  const pdfjs = await import(CDN + "pdf.min.mjs");
  const worker = await (await fetch(CDN + "pdf.worker.min.mjs")).text();
  pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([worker], { type: "text/javascript" }));
  const doc = await pdfjs.getDocument({ url: URL_ }).promise;
  status.remove();
  const pages = document.getElementById("pages");
  const width = document.documentElement.clientWidth - 16;
  const ratio = window.devicePixelRatio || 1;
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const scale = width / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale: scale * ratio });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = viewport.width / ratio + "px";
    canvas.style.height = viewport.height / ratio + "px";
    pages.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    if (restoreY > 0 && document.documentElement.scrollHeight >= restoreY + window.innerHeight) {
      window.scrollTo(0, restoreY);
      restoreY = 0;
    }
  }
  if (restoreY > 0) window.scrollTo(0, restoreY);
} catch (error) {
  status.textContent = "Could not render this PDF: " + (error && error.message ? error.message : error);
}
</script></body></html>`;
}

/** PDF preview that keeps its scroll position for thread tabs (sidebar fork). */
export function WorkspaceFilePdfPreview(props: {
  readonly uri: string | null;
  readonly restoreScrollY?: number;
  readonly onScrollSettle?: (y: number) => void;
}) {
  // The restore offset only seeds the first load; later reports must not reload the page.
  const [initialRestore] = useState(props.restoreScrollY ?? 0);
  const reportEdges = useReportPageEdges();
  const source = useMemo(() => {
    if (props.uri === null) return null;
    const origin = props.uri.match(/^https?:\/\/[^/]+/)?.[0];
    return origin ? { html: pdfViewerHtml(props.uri, initialRestore), baseUrl: origin } : null;
  }, [initialRestore, props.uri]);

  if (source === null) {
    return <FilePreviewLoading message="Preparing preview..." background="card" />;
  }

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as {
        type?: string;
        y?: unknown;
        prev?: unknown;
        next?: unknown;
      };
      if (message.type === "scroll" && typeof message.y === "number") {
        props.onScrollSettle?.(message.y);
      }
      if (message.type === "edges") {
        reportEdges?.({ prev: message.prev === true, next: message.next === true });
      }
    } catch {
      // Messages come only from the page above; anything else is ignored.
    }
  };

  return (
    <View className="flex-1 bg-card" testID="pdf-preview">
      <WebView
        source={source}
        originWhitelist={["*"]}
        javaScriptEnabled
        setSupportMultipleWindows={false}
        onMessage={handleMessage}
        style={{ flex: 1, backgroundColor: "#525659" }}
      />
    </View>
  );
}
