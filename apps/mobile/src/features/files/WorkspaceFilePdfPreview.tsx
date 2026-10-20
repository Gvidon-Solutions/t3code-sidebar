import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { useReportPageEdges } from "../panels/threadPagerContext";
import { FilePreviewLoading } from "./FilePreviewFeedback";
import { OPEN_FILE_POLL_MS, useOpenFileScreenActive } from "./useWorkspaceFileRefresh";

// Pinned pdf.js build. Android's WebView cannot display PDFs itself, so the
// sidebar fork renders them with pdf.js; the file loads from the server's own
// origin (the page's base URL) and never crosses origins.
const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";

function pdfViewerHtml(pdfUrl: string, restoreScrollY: number, pollMs: number): string {
  return `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=8">
<style>
  html, body { margin: 0; background: #525659; }
  .pages { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 8px 0; }
  canvas { background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
  #status { color: #eee; font: 14px sans-serif; padding: 32px 16px; text-align: center; }
</style></head>
<body><div id="status">Loading PDF…</div><div id="pages" class="pages"></div>
<script type="module">
const CDN = ${JSON.stringify(PDFJS_CDN)};
const POLL_MS = ${JSON.stringify(pollMs)};
let url = ${JSON.stringify(pdfUrl)};
let restoreY = ${JSON.stringify(Math.max(0, Math.round(restoreScrollY)))};
let active = true;
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

// The file's validator (size and mtime) from a GET whose body is dropped at once.
const fileVersion = async () => {
  const controller = new AbortController();
  const response = await fetch(url, { cache: "no-store", signal: controller.signal });
  controller.abort();
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, version: response.headers.get("etag") || response.headers.get("last-modified") || "" };
};
const withVersion = (version) => url + (url.includes("?") ? "&" : "?") + "pdf-version=" + encodeURIComponent(version);

let pdfjs = null;
let doc = null;
// Pages of the shown document; each canvas keeps the pixel ratio it was last drawn at.
let entries = [];
// Zoomed pages are re-drawn at the zoom's resolution once the pinch settles, so
// vector art and text stay sharp; pages off screen fall back to the base ratio.
const MAX_PAGE_PIXELS = 16_000_000;
let sharpenGeneration = 0;
const sharpen = async () => {
  if (entries.length === 0) return;
  const generation = ++sharpenGeneration;
  const view = window.visualViewport;
  const zoom = view ? view.scale : 1;
  const base = window.devicePixelRatio || 1;
  const top = view ? view.pageTop : window.scrollY;
  const bottom = top + (view ? view.height : window.innerHeight);
  for (const entry of entries) {
    if (generation !== sharpenGeneration) return;
    const rect = entry.canvas.getBoundingClientRect();
    const pageTop = rect.top + window.scrollY;
    const visible = pageTop < bottom && pageTop + rect.height > top;
    const cssWidth = rect.width;
    const cssHeight = rect.height;
    let res = visible ? base * Math.max(1, zoom) : base;
    res = Math.min(res, Math.sqrt(MAX_PAGE_PIXELS / Math.max(1, cssWidth * cssHeight)));
    if (Math.abs(res - entry.res) < 0.25) continue;
    const viewport = entry.page.getViewport({ scale: entry.fit * res });
    const scratch = document.createElement("canvas");
    scratch.width = Math.round(viewport.width);
    scratch.height = Math.round(viewport.height);
    try {
      entry.task?.cancel();
      entry.task = entry.page.render({ canvasContext: scratch.getContext("2d"), viewport });
      await entry.task.promise;
    } catch {
      continue;
    } finally {
      entry.task = null;
    }
    if (generation !== sharpenGeneration) return;
    entry.canvas.width = scratch.width;
    entry.canvas.height = scratch.height;
    entry.canvas.getContext("2d").drawImage(scratch, 0, 0);
    entry.res = res;
  }
};
let sharpenTimer = null;
const scheduleSharpen = () => {
  clearTimeout(sharpenTimer);
  sharpenTimer = setTimeout(() => void sharpen(), 250);
};
window.visualViewport?.addEventListener("resize", scheduleSharpen);
window.visualViewport?.addEventListener("scroll", scheduleSharpen);
// Renders into a detached container, so a reload swaps whole pages in at the reader's scroll.
const render = async (source) => {
  const next = await pdfjs.getDocument({ url: source }).promise;
  const pages = document.createElement("div");
  pages.className = "pages";
  const width = document.documentElement.clientWidth - 16;
  const ratio = window.devicePixelRatio || 1;
  const shown = document.getElementById("pages");
  const nextEntries = [];
  const first = doc === null;
  if (first) { status.remove(); pages.id = "pages"; shown.replaceWith(pages); }
  for (let number = 1; number <= next.numPages; number += 1) {
    const page = await next.getPage(number);
    const scale = width / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale: scale * ratio });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = viewport.width / ratio + "px";
    canvas.style.height = viewport.height / ratio + "px";
    pages.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    nextEntries.push({ page, canvas, fit: scale, res: ratio, task: null });
    if (first && restoreY > 0 && document.documentElement.scrollHeight >= restoreY + window.innerHeight) {
      window.scrollTo(0, restoreY);
      restoreY = 0;
    }
  }
  if (first) {
    if (restoreY > 0) window.scrollTo(0, restoreY);
  } else {
    const y = window.scrollY;
    const x = window.scrollX;
    pages.id = "pages";
    document.getElementById("pages").replaceWith(pages);
    window.scrollTo(x, y);
    doc.destroy();
  }
  doc = next;
  entries = nextEntries;
  scheduleSharpen();
};

let version = null;
let checking = false;
// A missing file also answers 404, so re-minting is rate-limited instead of looping.
let expiredAt = 0;
const check = async () => {
  if (!active || checking || doc === null) return;
  checking = true;
  try {
    const result = await fileVersion();
    if (!result.ok) {
      // An expired link (404) is re-minted by the app, which hands the new one back.
      if (result.status === 404 && Date.now() - expiredAt > 60_000) {
        expiredAt = Date.now();
        post({ type: "expired" });
      }
      return;
    }
    if (version !== null && result.version !== "" && result.version !== version) {
      await render(withVersion(result.version));
    }
    if (result.version !== "") version = result.version;
  } catch {
    // Offline or mid-write: the next poll tries again.
  } finally {
    checking = false;
  }
};
window.__t3SetUrl = (next) => { url = next; void check(); };
window.__t3SetActive = (next) => { active = next; if (next) void check(); };

try {
  pdfjs = await import(CDN + "pdf.min.mjs");
  const worker = await (await fetch(CDN + "pdf.worker.min.mjs")).text();
  pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([worker], { type: "text/javascript" }));
  // The versioned URL also keeps the WebView's HTTP cache from serving an older build.
  const first = await fileVersion().catch(() => null);
  if (first?.ok && first.version !== "") version = first.version;
  await render(version === null ? url : withVersion(version));
  setInterval(check, POLL_MS);
} catch (error) {
  status.textContent = "Could not render this PDF: " + (error && error.message ? error.message : error);
}
</script></body></html>`;
}

/**
 * PDF preview that keeps its scroll position for thread tabs (sidebar fork).
 * While on screen it re-checks the file every poll and swaps in a changed PDF
 * (a LaTeX rebuild) at the same scroll position.
 */
export function WorkspaceFilePdfPreview(props: {
  readonly uri: string | null;
  readonly restoreScrollY?: number;
  readonly onScrollSettle?: (y: number) => void;
  /** Re-mints an expired signed URL; the new `uri` reaches the page without a reload. */
  readonly onUrlExpired?: () => void;
}) {
  // The first URL and restore offset seed the page; later ones must not reload it.
  const [initialRestore] = useState(props.restoreScrollY ?? 0);
  const [initialUri, setInitialUri] = useState(props.uri);
  if (initialUri === null && props.uri !== null) setInitialUri(props.uri);
  const reportEdges = useReportPageEdges();
  const webViewRef = useRef<WebView<object>>(null);
  const active = useOpenFileScreenActive(true);
  const source = useMemo(() => {
    if (initialUri === null) return null;
    const origin = initialUri.match(/^https?:\/\/[^/]+/)?.[0];
    return origin
      ? { html: pdfViewerHtml(initialUri, initialRestore, OPEN_FILE_POLL_MS), baseUrl: origin }
      : null;
  }, [initialRestore, initialUri]);

  useEffect(() => {
    if (props.uri === null || props.uri === initialUri) return;
    webViewRef.current?.injectJavaScript(
      `window.__t3SetUrl?.(${JSON.stringify(props.uri)}); true;`,
    );
  }, [initialUri, props.uri]);
  useEffect(() => {
    webViewRef.current?.injectJavaScript(`window.__t3SetActive?.(${active}); true;`);
  }, [active]);

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
      if (message.type === "expired") props.onUrlExpired?.();
    } catch {
      // Messages come only from the page above; anything else is ignored.
    }
  };

  return (
    <View className="flex-1 bg-card" testID="pdf-preview">
      <WebView
        ref={webViewRef}
        source={source}
        originWhitelist={["*"]}
        javaScriptEnabled
        setSupportMultipleWindows={false}
        onMessage={handleMessage}
        onLoadEnd={() =>
          webViewRef.current?.injectJavaScript(`window.__t3SetActive?.(${active}); true;`)
        }
        style={{ flex: 1, backgroundColor: "#525659" }}
      />
    </View>
  );
}
